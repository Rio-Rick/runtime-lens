import assert from 'node:assert/strict';
import { Agent, DEFAULT_AGENT_CONFIG, createNoopAgent, type AgentTransport } from '../src/agent/core';
import { PROTOCOL_VERSION, type BatchMessage, type ClientMessage, type LogEvent, type ExprEvent } from '../src/protocol';
import { validateClientMessage } from '../src/protocol';

class FakeTransport implements AgentTransport {
  readonly sent: ClientMessage[] = [];
  helloPayload: ClientMessage | undefined;
  closed = false;
  throwOnSend = false;
  onMessage: ((json: string) => void) | undefined;

  /** Simulate the editor pushing a message down the wire (as ws-transport's onmessage now does). */
  receive(payload: unknown): void {
    this.onMessage?.(JSON.stringify(payload));
  }

  send(json: string): void {
    if (this.throwOnSend) {
      throw new Error('socket gone');
    }
    this.sent.push(JSON.parse(json) as ClientMessage);
  }

  hello(json: string): void {
    this.helloPayload = JSON.parse(json) as ClientMessage;
  }

  close(): void {
    this.closed = true;
  }

  batches(): BatchMessage[] {
    return this.sent.filter((m): m is BatchMessage => m.t === 'batch');
  }

  events(): Array<LogEvent | ExprEvent> {
    return this.batches().flatMap((b) => b.events) as Array<LogEvent | ExprEvent>;
  }
}

function makeAgent(transport: AgentTransport, overrides: Partial<typeof DEFAULT_AGENT_CONFIG> = {}): Agent {
  return new Agent(
    {
      ...DEFAULT_AGENT_CONFIG,
      sessionId: 'sess-1',
      token: 'tok',
      label: 'test',
      runtime: 'node',
      flushIntervalMs: 5,
      ...overrides
    },
    transport
  );
}

/** Swap globalThis.console for a recorder while a body runs. */
function withCapturedConsole<T>(body: (calls: Array<[string, unknown[]]>) => T): T {
  const calls: Array<[string, unknown[]]> = [];
  const original = globalThis.console;
  const fake = {} as Record<string, (...args: unknown[]) => void>;
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'table', 'trace']) {
    fake[level] = (...args: unknown[]) => {
      calls.push([level, args]);
    };
  }
  (globalThis as { console: unknown }).console = fake;
  try {
    return body(calls);
  } finally {
    (globalThis as { console: unknown }).console = original;
  }
}

describe('agent/core (console interception)', () => {
  it('sends a hello with the protocol version, token and session id', () => {
    const transport = new FakeTransport();
    const agent = makeAgent(transport);
    assert.ok(transport.helloPayload);
    assert.equal(transport.helloPayload?.t, 'hello');
    assert.equal(transport.helloPayload?.v, PROTOCOL_VERSION);
    assert.equal((transport.helloPayload as { token: string }).token, 'tok');
    agent.dispose();
  });

  it('forwards intercepted console calls to the original console, unchanged', () => {
    const transport = new FakeTransport();
    const calls = withCapturedConsole((recorded) => {
      const agent = makeAgent(transport);
      const obj = { a: 1 };
      agent.c('log', 'p1', '/p/a.ts', 3, 0, ['hello', 42, obj]);
      agent.c('warn', 'p2', '/p/a.ts', 4, 0, ['careful']);
      agent.c('error', 'p3', '/p/a.ts', 5, 0, [new Error('bad')]);
      agent.c('table', 'p4', '/p/a.ts', 6, 0, [[{ x: 1 }]]);
      agent.flush();
      agent.dispose();
      return recorded;
    });
    assert.deepEqual(calls.map(([level]) => level), ['log', 'warn', 'error', 'table']);
    assert.deepEqual(calls[0][1], ['hello', 42, { a: 1 }]);
    assert.equal((calls[2][1][0] as Error).message, 'bad', 'the original object identity is preserved');
  });

  it('captures every level with serialized args and original locations', () => {
    const transport = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(transport);
      for (const [i, level] of (['log', 'info', 'warn', 'error', 'debug', 'table'] as const).entries()) {
        agent.c(level, `p${i}`, '/p/a.ts', 10 + i, 2, [level, { i }]);
      }
      agent.flush();
      agent.dispose();
    });
    const events = transport.events() as LogEvent[];
    assert.equal(events.length, 6);
    assert.deepEqual(events.map((e) => e.level), ['log', 'info', 'warn', 'error', 'debug', 'table']);
    assert.equal(events[0].loc.file, '/p/a.ts');
    assert.equal(events[0].loc.line, 10);
    assert.equal(events[0].loc.column, 2);
    assert.deepEqual(events[0].args[0], { k: 'string', v: 'log', length: 3 });
    assert.equal(events[0].args[1].k, 'object');
  });

  it('produces batches that pass the server-side validator', () => {
    const transport = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(transport);
      const circular: Record<string, unknown> = { name: 'x' };
      circular.self = circular;
      agent.c('log', 'p', '/p/a.ts', 1, 0, [circular, new Map([['k', 1]]), 10n, undefined, NaN]);
      agent.e('q', '/p/a.ts', 2, 0, 'value', new Set([1, 2]));
      agent.flush();
      agent.dispose();
    });
    for (const batch of transport.batches()) {
      const res = validateClientMessage(JSON.parse(JSON.stringify(batch)));
      assert.equal(res.ok, true, res.ok ? '' : res.error);
    }
  });

  it('counts executions per probe id', () => {
    const transport = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(transport);
      for (let i = 0; i < 5; i++) {
        agent.c('log', 'loop', '/p/a.ts', 7, 0, ['i', i]);
      }
      agent.c('log', 'other', '/p/a.ts', 8, 0, ['once']);
      agent.flush();
      agent.dispose();
    });
    const events = transport.events();
    assert.deepEqual(events.filter((e) => e.id === 'loop').map((e) => e.count), [1, 2, 3, 4, 5]);
    assert.deepEqual(events.filter((e) => e.id === 'other').map((e) => e.count), [1]);
    assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3, 4, 5], 'sequence numbers are monotonic');
  });

  it('returns probed expression values unchanged, including identity', () => {
    const transport = new FakeTransport();
    const agent = makeAgent(transport);
    const obj = { deep: { value: 1 } };
    assert.equal(agent.e('p', '/a.ts', 1, 0, 'obj', obj), obj);
    assert.equal(agent.e('p', '/a.ts', 1, 0, '42', 42), 42);
    assert.equal(agent.e('p', '/a.ts', 1, 0, 'undefined', undefined), undefined);
    const fn = () => 7;
    assert.equal(agent.e('p', '/a.ts', 1, 0, 'fn', fn), fn);
    agent.flush();
    const exprs = transport.events() as ExprEvent[];
    assert.equal(exprs[0].t, 'expr');
    assert.equal(exprs[0].expr, 'obj');
    agent.dispose();
  });

  it('honours pause and the capture switches', () => {
    const transport = new FakeTransport();
    const calls = withCapturedConsole((recorded) => {
      const agent = makeAgent(transport);
      agent.setPaused(true);
      agent.c('log', 'p', '/a.ts', 1, 0, ['while paused']);
      agent.e('q', '/a.ts', 2, 0, 'x', 1);
      agent.flush();
      assert.equal(transport.events().length, 0, 'nothing is captured while paused');
      agent.setPaused(false);
      agent.c('log', 'p', '/a.ts', 1, 0, ['after resume']);
      agent.flush();
      assert.equal(transport.events().length, 1);
      agent.dispose();
      return recorded;
    });
    assert.equal(calls.length, 2, 'the user still sees both console lines');

    const off = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(off, { captureConsole: false, captureExpressions: false });
      agent.c('log', 'p', '/a.ts', 1, 0, ['x']);
      agent.e('q', '/a.ts', 2, 0, 'x', 1);
      agent.flush();
      agent.dispose();
    });
    assert.equal(off.events().length, 0);
  });

  it('batches: flushes automatically at maxBatchEvents and splits large buffers', () => {
    const transport = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(transport, { maxBatchEvents: 10, maxBufferedEvents: 1000 });
      for (let i = 0; i < 25; i++) {
        agent.c('log', 'p', '/a.ts', 1, 0, [i]);
      }
      agent.flush();
      const sizes = transport.batches().map((b) => b.events.length);
      assert.deepEqual(sizes, [10, 10, 5], `unexpected batch sizes: ${sizes.join(',')}`);
      agent.dispose();
    });
  });

  it('flushes on a timer without being asked', async () => {
    const transport = new FakeTransport();
    const agent = withCapturedConsole(() => {
      const a = makeAgent(transport, { flushIntervalMs: 5, maxBatchEvents: 1000 });
      a.c('log', 'p', '/a.ts', 1, 0, ['timed']);
      return a;
    });
    assert.equal(transport.batches().length, 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.ok(transport.batches().length >= 1, 'timer should have flushed');
    agent.dispose();
  });

  it('bounds its buffer and reports the number of dropped events', () => {
    const transport = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(transport, { maxBufferedEvents: 8, maxBatchEvents: 1000, flushIntervalMs: 100000 });
      for (let i = 0; i < 20; i++) {
        agent.c('log', 'p', '/a.ts', 1, 0, [i]);
      }
      assert.equal(agent.stats().buffered, 8);
      assert.equal(agent.stats().dropped, 12);
      agent.flush();
      const batch = transport.batches()[0];
      assert.equal(batch.events.length, 8);
      assert.equal(batch.dropped, 12);
      assert.equal(agent.stats().dropped, 0, 'the drop counter resets after being reported');
      agent.dispose();
    });
  });

  it('reports runtime errors and flushes them immediately', () => {
    const transport = new FakeTransport();
    const agent = makeAgent(transport, { flushIntervalMs: 100000 });
    agent.reportError(new Error('kaboom'), { file: '/a.ts', line: 4, column: 1 }, true);
    const events = transport.batches().flatMap((b) => b.events);
    assert.equal(events.length, 1);
    assert.equal(events[0].t, 'error');
    assert.equal((events[0] as { message: string }).message, 'kaboom');
    assert.equal((events[0] as { fatal: boolean }).fatal, true);
    agent.reportError('a string throw', { file: '/a.ts', line: 5, column: 0 }, false);
    assert.match(JSON.stringify(transport.sent), /a string throw/);
    agent.dispose();
  });

  it('disables itself instead of throwing when the transport dies', () => {
    const transport = new FakeTransport();
    const calls = withCapturedConsole((recorded) => {
      const agent = makeAgent(transport, { flushIntervalMs: 100000 });
      transport.throwOnSend = true;
      agent.c('log', 'p', '/a.ts', 1, 0, ['before death']);
      assert.doesNotThrow(() => agent.flush());
      assert.equal(agent.stats().disabled, true);
      agent.c('log', 'p', '/a.ts', 1, 0, ['after death']);
      agent.dispose();
      return recorded;
    });
    assert.equal(calls.length, 2, 'console output continues after the agent gives up');
  });

  it('survives values that cannot be serialized', () => {
    const transport = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(transport);
      const hostile = {
        get bang(): never {
          throw new Error('nope');
        }
      };
      assert.doesNotThrow(() => agent.c('log', 'p', '/a.ts', 1, 0, [hostile]));
      agent.flush();
      agent.dispose();
    });
    assert.equal(transport.events().length, 1);
  });

  it('wires transport.onMessage on construction so a live push can reach the agent', () => {
    const transport = new FakeTransport();
    const agent = makeAgent(transport);
    assert.equal(typeof transport.onMessage, 'function', 'Agent must register a message handler on its transport');
    agent.dispose();
  });

  it('applyConfig updates objectDepth, capture switches and pause state on the next capture', () => {
    const transport = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(transport, { objectDepth: 3, captureConsole: true, captureExpressions: true });
      const deep = { a: { b: { c: { d: { e: 'too deep at depth 3' } } } } };
      agent.c('log', 'p1', '/a.ts', 1, 0, [deep]);
      agent.applyConfig({ captureConsole: true, captureExpressions: true, paused: false, objectDepth: 10 });
      agent.c('log', 'p2', '/a.ts', 2, 0, [deep]);
      agent.flush();
      agent.dispose();
    });
    const events = transport.events() as LogEvent[];
    const shallow = JSON.stringify(events[0].args[0]);
    const full = JSON.stringify(events[1].args[0]);
    assert.match(shallow, /maxdepth/, 'depth 3 truncates a 4-level-deep object');
    assert.doesNotMatch(full, /maxdepth/, 'depth 10 captures the same object in full after applyConfig');
    assert.match(full, /too deep at depth 3/);
  });

  it('a config push delivered through transport.onMessage reaches the agent end-to-end', () => {
    const transport = new FakeTransport();
    withCapturedConsole(() => {
      const agent = makeAgent(transport, { objectDepth: 3 });
      const deep = { a: { b: { c: { d: 'value' } } } };
      transport.receive({
        t: 'config',
        v: PROTOCOL_VERSION,
        captureConsole: true,
        captureExpressions: true,
        paused: false,
        objectDepth: 10
      });
      agent.c('log', 'p', '/a.ts', 1, 0, [deep]);
      agent.flush();
      agent.dispose();
    });
    assert.doesNotMatch(JSON.stringify((transport.events() as LogEvent[])[0].args[0]), /maxdepth/);
  });

  it('ignores malformed or stale-version pushes instead of throwing', () => {
    const transport = new FakeTransport();
    const agent = makeAgent(transport, { objectDepth: 3 });
    assert.doesNotThrow(() => transport.receive({ t: 'config', v: '2.0.0', objectDepth: 10 }));
    assert.doesNotThrow(() => transport.receive('not even an object'));
    assert.doesNotThrow(() => transport.onMessage?.('{ not json'));
    agent.dispose();
  });

  it('sends a bye and closes the transport on dispose', () => {
    const transport = new FakeTransport();
    const agent = makeAgent(transport);
    agent.dispose('test-over');
    const bye = transport.sent.find((m) => m.t === 'bye') as { reason?: string } | undefined;
    assert.ok(bye, 'expected a bye message');
    assert.equal(bye?.reason, 'test-over');
    assert.equal(transport.closed, true);
  });

  it('createNoopAgent forwards to console and passes values through', () => {
    const calls = withCapturedConsole((recorded) => {
      const noop = createNoopAgent();
      noop.c('warn', 'id', '/a.ts', 1, 0, ['still printed', 1]);
      assert.equal(noop.e('id', '/a.ts', 2, 0, 'x', 99), 99);
      return recorded;
    });
    assert.deepEqual(calls, [['warn', ['still printed', 1]]]);
  });
});
