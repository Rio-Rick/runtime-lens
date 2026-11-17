import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import { Agent, DEFAULT_AGENT_CONFIG, errorProbeId } from '../src/agent/core';
import { installProcessHooks } from '../src/agent/node-transport';
import { instrument } from '../src/instrumentation/transform';
import {
  MAX_EVENT_ID_LENGTH,
  MAX_LOG_ARGS,
  parseClientMessage,
  validateSerializedValue
} from '../src/protocol';
import { RuntimeServer } from '../src/runtime/server';
import { EventStore } from '../src/runtime/store';
import { serialize } from '../src/serialization/serializer';
import { clampInt } from '../src/utils/numbers';
import { createNonce } from '../src/utils/nonce';
import { shouldInstrument } from '../src/utils/paths';

/** Run `fn` against an agent and return whether the server-side validator accepts what it sent. */
function sentBatchIsAccepted(fn: (agent: Agent) => void): { ok: boolean; error?: string } {
  const sent: string[] = [];
  const agent = new Agent(
    { ...DEFAULT_AGENT_CONFIG, sessionId: 's', token: 't', runtime: 'node', label: 'x', flushIntervalMs: 1_000_000 },
    { hello() {}, send: (json) => sent.push(json), close() {} }
  );
  const originalConsole = { ...console };
  console.log = console.error = console.warn = (): void => undefined;
  try {
    fn(agent);
    agent.flush();
  } finally {
    Object.assign(console, originalConsole);
    agent.dispose();
  }
  const batch = sent.find((json) => JSON.parse(json).t === 'batch');
  assert.ok(batch, 'the agent should have sent a batch');
  const parsed = parseClientMessage(batch, 4 * 1024 * 1024, undefined);
  return parsed.ok ? { ok: true } : { ok: false, error: parsed.error };
}

describe('agent output always passes server validation (one bad event used to drop the whole batch)', () => {
  const cases: Array<[string, (agent: Agent) => void]> = [
    ['an Error with a 20 000 character message', (a) => a.c('error', 'i1', '/a.ts', 1, 0, [new Error('x'.repeat(20_000))])],
    ['an object with a 5 000 character key', (a) => a.c('log', 'i2', '/a.ts', 1, 0, [{ ['k'.repeat(5_000)]: 1 }])],
    ['a call spread over 100 arguments', (a) => a.c('log', 'i3', '/a.ts', 1, 0, Array.from({ length: 100 }, (_, i) => i))],
    ['a BigInt with 30 000 digits', (a) => a.c('log', 'i4', '/a.ts', 1, 0, [2n ** 100_000n])],
    ['a symbol with a huge description', (a) => a.c('log', 'i5', '/a.ts', 1, 0, [Symbol('s'.repeat(30_000))])],
    ['a RegExp with a huge source', (a) => a.c('log', 'i6', '/a.ts', 1, 0, [new RegExp('a'.repeat(30_000))])],
    ['a function with a huge name', (a) => a.c('log', 'i7', '/a.ts', 1, 0, [Object.defineProperty(() => 1, 'name', { value: 'f'.repeat(5_000) })])],
    ['a runtime error from a deep path', (a) => a.reportError(new Error('boom'), { file: `/home/u/${'workspace/'.repeat(14)}app`, line: 1, column: 0 }, true)],
    ['a browser error with a long bundler URL', (a) => a.reportError(new Error('boom'), { file: `http://localhost:3000/_next/static/chunks/${'a'.repeat(140)}.js`, line: 3, column: 4 }, false)],
    ['a cross-origin browser error (filename "", line 0)', (a) => a.reportError('Script error.', { file: '', line: 0, column: 0 }, false)]
  ];
  for (const [name, fn] of cases) {
    it(`accepts ${name}`, () => {
      const result = sentBatchIsAccepted(fn);
      assert.equal(result.ok, true, result.error);
    });
  }

  it('says how many arguments were left out', () => {
    const value = serialize(1);
    assert.equal(value.k, 'number');
    const sent: string[] = [];
    const agent = new Agent(
      { ...DEFAULT_AGENT_CONFIG, sessionId: 's', token: 't', runtime: 'node', label: 'x', flushIntervalMs: 1_000_000 },
      { hello() {}, send: (json) => sent.push(json), close() {} }
    );
    const log = console.log;
    console.log = (): void => undefined;
    try {
      agent.c('log', 'id', '/a.ts', 1, 0, Array.from({ length: 70 }, (_, i) => i));
    } finally {
      console.log = log;
    }
    agent.flush();
    const event = JSON.parse(sent.find((j) => JSON.parse(j).t === 'batch') as string).events[0];
    assert.equal(event.args.length, MAX_LOG_ARGS);
    assert.deepEqual(event.args[MAX_LOG_ARGS - 1], { k: 'unserializable', hint: '7 more arguments not captured' });
    agent.dispose();
  });

  it('keeps an error probe id unchanged when it fits, and within the limit when it does not', () => {
    assert.equal(errorProbeId('/app/src/a.ts', 12), 'err:/app/src/a.ts:12');
    const long = errorProbeId(`/${'d/'.repeat(200)}file.ts`, 12345);
    assert.ok(long.length <= MAX_EVENT_ID_LENGTH);
    assert.ok(long.endsWith('file.ts:12345'), 'the tail identifies the file');
  });

  it('every serializer result validates, even for hostile values', () => {
    const circular: Record<string, unknown> = { ['c'.repeat(3_000)]: 1 };
    circular.self = circular;
    for (const value of [circular, 2n ** 50_000n, new Error('e'.repeat(50_000)), new Map([['k'.repeat(9_000), 1]])]) {
      assert.equal(validateSerializedValue(serialize(value, { depth: 4 })), true);
    }
  });
});

describe('serializer error detection', () => {
  it('shows a plain object with an error-like `name` as an object, not as an empty error', () => {
    const value = serialize({ name: 'ValidationError', field: 'email' });
    assert.equal(value.k, 'object');
  });

  it('still recognises real errors and error-like host objects', () => {
    assert.equal(serialize(new TypeError('x')).k, 'error');
    class FakeDomException {
      get [Symbol.toStringTag](): string {
        return 'DOMException';
      }
      name = 'AbortError';
      message = 'aborted';
    }
    assert.equal(serialize(new FakeDomException()).k, 'error');
  });
});

describe('transform: `// ?` probes', () => {
  const probes = (source: string): string[] =>
    instrument(source, { filename: '/proj/src/a.ts', agentModule: 'agent', moduleKind: 'esm', captureConsole: false, sourceMaps: false }).probes.map(
      (p) => `L${p.line}:${p.text}`
    );

  it('probes only the statement the comment trails, not the one after it', () => {
    assert.deepEqual(probes('const a = compute(); // ?\nfoo();\nbar();\n'), ['L1:compute()']);
  });

  it('does not probe the `return` that follows a probed declaration', () => {
    assert.deepEqual(probes('function f() {\n  const x = g(); // ?\n  return x;\n}\n'), ['L2:g()']);
  });

  it('treats a multi-line statement by the line the comment is on', () => {
    assert.deepEqual(probes('const x = foo(\n  a,\n  b\n); // ?\nbar();\n'), ['L1:foo(\n  a,\n  b\n)']);
  });

  it('supports `export const x = ...; // ?`', () => {
    assert.deepEqual(probes('export const a = f(); // ?\nexport const b = g();\n'), ['L1:f()']);
  });
});

describe('shouldInstrument', () => {
  it('does not treat folders ABOVE the project root as output folders', () => {
    assert.equal(shouldInstrument('/home/me/build/app/src/index.ts', { root: '/home/me/build/app' }), true);
    assert.equal(shouldInstrument('/opt/dist/app/src/index.ts', { root: '/opt/dist/app' }), true);
    assert.equal(shouldInstrument('C:/work/out/app/src/index.ts', { root: 'c:\\work\\out\\app' }), true);
  });

  it('still excludes output and dependency folders inside the project', () => {
    const root = '/home/me/build/app';
    assert.equal(shouldInstrument(`${root}/dist/index.js`, { root }), false);
    assert.equal(shouldInstrument(`${root}/node_modules/x/index.js`, { root }), false);
    assert.equal(shouldInstrument(`${root}/src/.next/server.js`, { root }), false);
  });

  it('keeps the full-path rule for files outside the root', () => {
    assert.equal(shouldInstrument('/elsewhere/node_modules/x/index.js', { root: '/home/me/app' }), false);
  });
});

describe('settings numbers', () => {
  it('rounds down and clamps, so a fractional setting cannot break activation', () => {
    assert.equal(clampInt(5000.5, 50, 100_000), 5000);
    assert.equal(clampInt(-3, 0, 10), 0);
    assert.equal(clampInt(99, 0, 10), 10);
    assert.equal(clampInt(Number.NaN, 7, 10), 7);
    assert.equal(clampInt('12' as unknown as number, 7, 10), 7);
  });

  it('EventStore accepts a fractional history size and ignores a resize to the same size', () => {
    const store = new EventStore(5000.5, () => '');
    assert.equal(store.stats().capacity, 5000);
    store.setMaxHistory(5000.9);
    assert.equal(store.stats().capacity, 5000);
    store.setMaxHistory(100.2);
    assert.equal(store.stats().capacity, 100);
  });
});

describe('createNonce', () => {
  it('is 32 characters from the CSPRNG and differs per call', () => {
    const a = createNonce();
    assert.match(a, /^[A-Za-z0-9]{32}$/);
    assert.notEqual(a, createNonce());
  });
});

describe('server: unparsable request targets', () => {
  async function rawRequest(port: number, request: string): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
      socket.on('data', (chunk) => (data += chunk.toString()));
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
      setTimeout(() => socket.destroy(), 500);
    });
  }

  it('answers 404 instead of throwing for `GET //` (before authentication)', async () => {
    const server = new RuntimeServer({ token: 'a'.repeat(64) });
    const { port } = await server.start();
    try {
      const http = await rawRequest(port, 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
      assert.match(http, /^HTTP\/1\.1 404/);
      const upgrade = await rawRequest(
        port,
        'GET // HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
      assert.match(upgrade, /^HTTP\/1\.1 404/);
    } finally {
      await server.stop();
    }
  });
});

describe('node agent process hooks', () => {
  const emit = (proc: NodeJS.Process, event: string, ...args: unknown[]): boolean => (proc as unknown as EventEmitter).emit(event, ...args);

  /** Stand-in for `process`: records what the agent reports and lets a test emit events. */
  function fakeProcess(extraRejectionListener = false): { proc: NodeJS.Process; reported: Array<{ fatal: boolean; message: string }>; agent: Agent } {
    const proc = new EventEmitter() as unknown as NodeJS.Process;
    (proc as { execArgv: string[] }).execArgv = [];
    (proc as { env: NodeJS.ProcessEnv }).env = {};
    const reported: Array<{ fatal: boolean; message: string }> = [];
    const agent = { reportError: (err: unknown, _loc: unknown, fatal: boolean) => reported.push({ fatal, message: String((err as Error).message ?? err) }), flush() {} } as unknown as Agent;
    if (extraRejectionListener) {
      proc.on('unhandledRejection', () => undefined);
    }
    installProcessHooks(agent, '/app', proc);
    return { proc, reported, agent };
  }

  it('observes crashes through uncaughtExceptionMonitor (no uncaughtException listener that changes the exit code)', () => {
    const { proc, reported } = fakeProcess();
    assert.equal(proc.listenerCount('uncaughtException'), 0);
    emit(proc, 'uncaughtExceptionMonitor', new Error('boom'), 'uncaughtException');
    assert.deepEqual(reported, [{ fatal: true, message: 'boom' }]);
  });

  it('restores the default crash for an unhandled rejection when it is the only listener', () => {
    const { proc, reported } = fakeProcess();
    const reason = new Error('rejected');
    assert.throws(() => emit(proc, 'unhandledRejection', reason, Promise.resolve()), (err) => err === reason);
    // the re-raised error reaches the crash monitor next; it must not be reported twice
    emit(proc, 'uncaughtExceptionMonitor', reason, 'uncaughtException');
    assert.equal(reported.length, 1);
    assert.equal(reported[0].fatal, true);
  });

  it('wraps a non-Error rejection reason when restoring the default crash', () => {
    const { proc } = fakeProcess();
    assert.throws(() => emit(proc, 'unhandledRejection', 'plain string', Promise.resolve()), /Unhandled promise rejection: plain string/);
  });

  it('only reports (never throws) when the app has its own unhandledRejection handler', () => {
    const { proc, reported } = fakeProcess(true);
    assert.doesNotThrow(() => emit(proc, 'unhandledRejection', new Error('handled elsewhere'), Promise.resolve()));
    assert.deepEqual(reported, [{ fatal: false, message: 'handled elsewhere' }]);
  });

  it('only reports when the app chose an --unhandled-rejections mode', () => {
    const { proc, reported } = fakeProcess();
    (proc as { execArgv: string[] }).execArgv = ['--unhandled-rejections=warn'];
    assert.doesNotThrow(() => emit(proc, 'unhandledRejection', new Error('warn mode'), Promise.resolve()));
    assert.equal(reported[0].fatal, false);
  });
});
