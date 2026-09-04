import assert from 'node:assert/strict';
import {
  ABSOLUTE_MAX_PAYLOAD_BYTES,
  MAX_EVENTS_PER_BATCH,
  PROTOCOL_MAJOR,
  PROTOCOL_VERSION,
  isCompatibleVersion,
  parseClientMessage,
  parseServerMessage,
  validateClientMessage,
  validateServerMessage,
  validateSerializedValue,
  type RuntimeEvent
} from '../src/protocol';
import { serialize } from '../src/serialization/serializer';

const V = PROTOCOL_VERSION;

function logEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    t: 'log',
    id: 'abc123abc123',
    seq: 0,
    ts: Date.now(),
    count: 1,
    level: 'log',
    loc: { file: '/p/a.ts', line: 3, column: 0 },
    args: [serialize('hello'), serialize(1)],
    ...overrides
  };
}

describe('protocol', () => {
  it('exposes a version whose major matches PROTOCOL_MAJOR', () => {
    assert.equal(Number(PROTOCOL_VERSION.split('.')[0]), PROTOCOL_MAJOR);
    assert.equal(isCompatibleVersion(PROTOCOL_VERSION), true);
    assert.equal(isCompatibleVersion('1.99.3'), true);
    assert.equal(isCompatibleVersion('2.0.0'), false);
    assert.equal(isCompatibleVersion('0.9.0'), false);
    assert.equal(isCompatibleVersion(undefined), false);
    assert.equal(isCompatibleVersion(1), false);
    assert.equal(isCompatibleVersion('banana'), false);
  });

  it('accepts a well-formed hello and binds the token', () => {
    const res = validateClientMessage(
      { t: 'hello', v: V, token: 'tok', sessionId: 's1', runtime: 'node', label: 'node (pid 1)', pid: 1, cwd: '/p' },
      'tok'
    );
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.value.t, 'hello');
    assert.equal(res.ok && (res.value as { runtime: string }).runtime, 'node');
  });

  it('rejects hello with the wrong or missing token', () => {
    const bad = validateClientMessage({ t: 'hello', v: V, token: 'nope', sessionId: 's1' }, 'tok');
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.code, 'bad-token');

    const missing = validateClientMessage({ t: 'hello', v: V, sessionId: 's1' }, 'tok');
    assert.equal(!missing.ok && missing.code, 'bad-token');
  });

  it('normalises an unknown runtime kind instead of failing', () => {
    const res = validateClientMessage({ t: 'hello', v: V, token: 't', sessionId: 's', runtime: 'deno' }, 't');
    assert.equal(res.ok && (res.value as { runtime: string }).runtime, 'unknown');
  });

  it('rejects incompatible protocol versions with bad-version', () => {
    const res = validateClientMessage({ t: 'hello', v: '2.0.0', token: 't', sessionId: 's' }, 't');
    assert.equal(!res.ok && res.code, 'bad-version');
  });

  it('rejects non-objects, unknown types and bad session ids', () => {
    for (const raw of [null, 42, 'x', [], undefined]) {
      const res = validateClientMessage(raw);
      assert.equal(res.ok, false);
    }
    assert.equal(!validateClientMessage({ t: 'nope', v: V, sessionId: 's' }).ok, true);
    assert.equal(!validateClientMessage({ t: 'bye', v: V, sessionId: '' }).ok, true);
    assert.equal(!validateClientMessage({ t: 'bye', v: V, sessionId: 'x'.repeat(65) }).ok, true);
  });

  it('validates batches of log, expr and error events', () => {
    const res = validateClientMessage({
      t: 'batch',
      v: V,
      sessionId: 's1',
      dropped: 4,
      events: [
        logEvent(),
        {
          t: 'expr',
          id: 'e1',
          seq: 1,
          ts: 1,
          count: 2,
          expr: 'user.name',
          loc: { file: '/p/a.ts', line: 9, column: 2 },
          value: serialize({ name: 'ada' })
        },
        {
          t: 'error',
          id: 'x1',
          seq: 2,
          ts: 2,
          count: 1,
          message: 'boom',
          stack: 'Error: boom\n at a',
          fatal: true,
          loc: { file: '/p/a.ts', line: 1, column: 0 }
        }
      ]
    });
    assert.equal(res.ok, true);
    const events = res.ok ? ((res.value as { events: RuntimeEvent[] }).events as RuntimeEvent[]) : [];
    assert.deepEqual(events.map((e) => e.t), ['log', 'expr', 'error']);
    assert.equal(res.ok && (res.value as { dropped?: number }).dropped, 4);
  });

  it('rejects malformed events field by field', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['missing id', logEvent({ id: undefined })],
      ['long id', logEvent({ id: 'x'.repeat(129) })],
      ['negative seq', logEvent({ seq: -1 })],
      ['non-numeric ts', logEvent({ ts: 'now' })],
      ['zero count', logEvent({ count: 0 })],
      ['missing loc', logEvent({ loc: undefined })],
      ['loc.line 0', logEvent({ loc: { file: '/a', line: 0, column: 0 } })],
      ['loc.column negative', logEvent({ loc: { file: '/a', line: 1, column: -2 } })],
      ['empty loc.file', logEvent({ loc: { file: '', line: 1, column: 0 } })],
      ['unknown level', logEvent({ level: 'critical' })],
      ['args not array', logEvent({ args: 'nope' })],
      ['too many args', logEvent({ args: new Array(65).fill(serialize(1)) })],
      ['bad arg shape', logEvent({ args: [{ k: 'wat' }] })],
      ['unknown event type', logEvent({ t: 'metric' })],
      ['expr value missing', { t: 'expr', id: 'a', seq: 0, ts: 0, count: 1, expr: 'x', loc: { file: '/a', line: 1, column: 0 } }]
    ];
    for (const [name, event] of cases) {
      const res = validateClientMessage({ t: 'batch', v: V, sessionId: 's', events: [event] });
      assert.equal(res.ok, false, `expected failure: ${name}`);
      assert.equal(!res.ok && res.code, 'bad-message', name);
    }
  });

  it('rejects oversized batches with too-large', () => {
    const res = validateClientMessage({
      t: 'batch',
      v: V,
      sessionId: 's',
      events: new Array(MAX_EVENTS_PER_BATCH + 1).fill(logEvent())
    });
    assert.equal(!res.ok && res.code, 'too-large');
  });

  it('validates every serialized value kind and rejects impostors', () => {
    const good = [
      serialize('a'),
      serialize(1),
      serialize(NaN),
      serialize(true),
      serialize(null),
      serialize(undefined),
      serialize(1n),
      serialize(Symbol('s')),
      serialize(new Date()),
      serialize(/x/),
      serialize(() => 1),
      serialize(new Error('e')),
      serialize([1, 2]),
      serialize({ a: 1 }),
      serialize(new Map([['a', 1]])),
      serialize(new Set([1])),
      serialize(new WeakMap())
    ];
    for (const value of good) {
      assert.equal(validateSerializedValue(value), true, JSON.stringify(value));
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(validateSerializedValue(serialize(circular)), true);

    for (const bad of [
      null,
      'string',
      { k: 'unknown-kind' },
      { k: 'string', v: 1 },
      { k: 'number', v: 'nope' },
      { k: 'boolean', v: 'true' },
      { k: 'array', entries: 'x' },
      { k: 'array', entries: [{ k: 'bogus' }] },
      { k: 'object', entries: [['a']] },
      { k: 'object', entries: [[1, { k: 'null' }]] },
      { k: 'map', entries: [[{ k: 'null' }]] },
      { k: 'circular' },
      { k: 'maxdepth' }
    ]) {
      assert.equal(validateSerializedValue(bad), false, JSON.stringify(bad));
    }
  });

  it('guards against deeply nested value bombs', () => {
    let bomb: Record<string, unknown> = { k: 'null' };
    for (let i = 0; i < 64; i++) {
      bomb = { k: 'array', entries: [bomb] };
    }
    assert.equal(validateSerializedValue(bomb), false, 'nesting beyond 32 levels is refused');
  });

  it('parseClientMessage enforces the byte budget before parsing', () => {
    const payload = JSON.stringify({ t: 'bye', v: V, sessionId: 's' });
    assert.equal(parseClientMessage(payload, 1024).ok, true);

    const tooBig = parseClientMessage(payload, 4);
    assert.equal(!tooBig.ok && tooBig.code, 'too-large');
    assert.match(!tooBig.ok ? tooBig.error : '', /exceeds limit/);

    const overAbsolute = parseClientMessage('x'.repeat(16), ABSOLUTE_MAX_PAYLOAD_BYTES * 10);
    assert.equal(!overAbsolute.ok && overAbsolute.code, 'bad-message', 'the absolute cap still applies');
  });

  it('parseClientMessage accepts Buffers and rejects invalid JSON', () => {
    const buf = Buffer.from(JSON.stringify({ t: 'bye', v: V, sessionId: 's', reason: 'exit' }), 'utf8');
    const res = parseClientMessage(buf, 1024);
    assert.equal(res.ok, true);
    assert.equal(res.ok && (res.value as { reason?: string }).reason, 'exit');

    const broken = parseClientMessage('{ not json', 1024);
    assert.equal(!broken.ok && broken.code, 'bad-message');
    assert.match(!broken.ok ? broken.error : '', /invalid JSON/);
  });

  it('truncates hostile long strings instead of storing them', () => {
    const res = validateClientMessage({ t: 'bye', v: V, sessionId: 's', reason: 'r'.repeat(5000) });
    assert.equal(res.ok, true);
    assert.equal(res.ok ? (res.value as { reason: string }).reason.length : -1, 500);
  });
});

describe('protocol: server -> agent messages', () => {
  it('validates a well-formed config push', () => {
    const res = validateServerMessage({
      t: 'config',
      v: V,
      captureConsole: true,
      captureExpressions: false,
      paused: true,
      objectDepth: 10
    });
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.ok && res.value,
      { t: 'config', v: V, captureConsole: true, captureExpressions: false, paused: true, objectDepth: 10 }
    );
  });

  it('floors a fractional objectDepth and rejects a negative one', () => {
    const floored = validateServerMessage({
      t: 'config',
      v: V,
      captureConsole: true,
      captureExpressions: true,
      paused: false,
      objectDepth: 7.9
    });
    assert.equal(floored.ok && floored.value.t === 'config' && floored.value.objectDepth, 7);

    const negative = validateServerMessage({
      t: 'config',
      v: V,
      captureConsole: true,
      captureExpressions: true,
      paused: false,
      objectDepth: -1
    });
    assert.equal(!negative.ok && negative.code, 'bad-message');
  });

  it('rejects a config push missing a required field', () => {
    const res = validateServerMessage({ t: 'config', v: V, captureConsole: true, paused: false, objectDepth: 3 });
    assert.equal(!res.ok && res.code, 'bad-message');
    assert.match(!res.ok ? res.error : '', /captureExpressions/);
  });

  it('rejects an incompatible protocol version', () => {
    const res = validateServerMessage({
      t: 'config',
      v: '2.0.0',
      captureConsole: true,
      captureExpressions: true,
      paused: false,
      objectDepth: 3
    });
    assert.equal(!res.ok && res.code, 'bad-version');
  });

  it('parseServerMessage parses JSON and rejects garbage', () => {
    const good = parseServerMessage(
      JSON.stringify({ t: 'config', v: V, captureConsole: true, captureExpressions: true, paused: false, objectDepth: 10 })
    );
    assert.equal(good.ok, true);

    const bad = parseServerMessage('{ not json');
    assert.equal(!bad.ok && bad.code, 'bad-message');
  });
});
