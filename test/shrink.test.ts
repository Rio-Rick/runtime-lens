import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, validateClientMessage, type ErrorEvent, type ExprEvent, type LogEvent, type SerializedValue } from '../src/protocol';
import { OVERSIZE_HINT, shrinkEvent, shrinkValue } from '../src/agent/shrink';
import { utf8ByteLength } from '../src/utils/bytes';

const loc = { file: '/a.ts', line: 1, column: 0 };
const bytes = (value: unknown): number => utf8ByteLength(JSON.stringify(value));
const num = (v: number): SerializedValue => ({ k: 'number', v });
const str = (v: string): SerializedValue => ({ k: 'string', v });
const log = (args: SerializedValue[]): LogEvent => ({ t: 'log', id: 'p', seq: 1, ts: 1, loc, count: 1, level: 'log', args });
const bigArray = (n: number, inner: () => SerializedValue): SerializedValue => ({
  k: 'array',
  entries: Array.from({ length: n }, inner),
  length: n
});

/** A batch containing only this event must still pass the protocol validator the server applies. */
function assertValidOnTheWire(event: LogEvent | ExprEvent | ErrorEvent): void {
  const res = validateClientMessage({ t: 'batch', v: PROTOCOL_VERSION, sessionId: 's', events: [event] });
  assert.equal(res.ok, true, res.ok ? '' : res.error);
}

describe('agent/shrink', () => {
  describe('shrinkEvent', () => {
    it('returns the very same event when it already fits', () => {
      const event = log([str('hello'), num(1)]);
      assert.equal(shrinkEvent(event, 100_000), event);
    });

    it('shrinks an oversized log to fit, keeps it valid, and keeps the true length', () => {
      const event = log([bigArray(1_000, () => ({ k: 'object', entries: [['text', str('x'.repeat(500))]], size: 1 }))]);
      assert.ok(bytes(event) > 200_000);
      const small = shrinkEvent(event, 20_000) as LogEvent;
      assert.ok(bytes(small) <= 20_000, `got ${bytes(small)} bytes`);
      assertValidOnTheWire(small);
      const arg = small.args[0] as Extract<SerializedValue, { k: 'array' }>;
      assert.equal(arg.length, 1_000, 'the real length is still reported, so the UI shows "N more not captured"');
      assert.ok(arg.entries.length < 1_000 && arg.entries.length > 0);
      assert.equal(arg.truncated, true);
    });

    it('prefers the gentlest level that fits (keeps as much as it can)', () => {
      const event = log([bigArray(200, () => num(1))]);
      const small = shrinkEvent(event, bytes(event) - 100) as LogEvent;
      const kept = (small.args[0] as { entries: unknown[] }).entries.length;
      assert.equal(kept, 50, 'the first level keeps 50 entries, not the harshest 1');
    });

    it('cuts long strings and records the original length', () => {
      const small = shrinkEvent(log([str('y'.repeat(100_000))]), 5_000) as LogEvent;
      const arg = small.args[0] as Extract<SerializedValue, { k: 'string' }>;
      assert.equal(arg.truncated, true);
      assert.equal(arg.length, 100_000);
      assert.ok(arg.v.length <= 2_000);
    });

    it('shrinks nested containers, Maps and Sets too', () => {
      const nested: SerializedValue = {
        k: 'map',
        size: 400,
        entries: Array.from({ length: 400 }, (_, i) => [str(`k${i}`), { k: 'set', size: 100, entries: Array.from({ length: 100 }, (_, j) => num(j)) } as SerializedValue])
      };
      const small = shrinkEvent(log([nested]), 15_000) as LogEvent;
      assert.ok(bytes(small) <= 15_000);
      assertValidOnTheWire(small);
    });

    it('shrinks a probed expression value', () => {
      const event: ExprEvent = { t: 'expr', id: 'p', seq: 1, ts: 1, loc, count: 1, expr: 'list', value: bigArray(2_000, () => str('z'.repeat(200))) };
      const small = shrinkEvent(event, 10_000) as ExprEvent;
      assert.ok(bytes(small) <= 10_000);
      assert.equal(small.expr, 'list');
      assertValidOnTheWire(small);
    });

    it('shortens a huge runtime error message and stack', () => {
      const event: ErrorEvent = { t: 'error', id: 'p', seq: 1, ts: 1, loc, count: 1, message: 'm'.repeat(200_000), stack: 's'.repeat(200_000), fatal: false };
      const small = shrinkEvent(event, 10_000) as ErrorEvent;
      assert.ok(bytes(small) <= 10_000);
      assertValidOnTheWire(small);
    });

    it('as a last resort replaces the payload with an explanatory placeholder', () => {
      // 64 arguments (the protocol maximum): even the harshest level leaves ~64 containers, far over budget.
      const event = log(Array.from({ length: 64 }, () => bigArray(500, () => str('q'.repeat(300)))));
      const small = shrinkEvent(event, 2_000) as LogEvent;
      assert.ok(bytes(small) <= 2_000, `got ${bytes(small)} bytes`);
      assert.equal(small.args.length, 1);
      const arg = small.args[0] as { k: string; hint: string };
      assert.equal(arg.k, 'unserializable');
      assert.ok(arg.hint.startsWith(OVERSIZE_HINT));
      assertValidOnTheWire(small);
    });

    it('drops an unfittable console.table payload rather than sending it', () => {
      const event: LogEvent = {
        ...log([num(1)]),
        level: 'table',
        table: { columns: ['a'], rows: Array.from({ length: 300 }, (_, i) => ({ key: String(i), cells: [str('c'.repeat(400))] })) } as unknown as LogEvent['table']
      };
      const small = shrinkEvent(event, 500) as LogEvent;
      assert.equal(small.table, undefined);
    });

    it('never grows the event and does not mutate its input', () => {
      const event = log([bigArray(300, () => str('w'.repeat(100)))]);
      const before = JSON.stringify(event);
      const small = shrinkEvent(event, 4_000);
      assert.equal(JSON.stringify(event), before, 'input untouched');
      assert.ok(bytes(small) <= bytes(event));
    });
  });

  describe('shrinkValue', () => {
    it('passes primitives through unchanged', () => {
      for (const value of [num(1), { k: 'null' } as SerializedValue, { k: 'undefined' } as SerializedValue, { k: 'boolean', v: true } as SerializedValue]) {
        assert.equal(shrinkValue(value, 1, 1), value);
      }
    });

    it('does not mark a container truncated when nothing was cut', () => {
      const value: SerializedValue = { k: 'array', entries: [num(1), num(2)], length: 2 };
      assert.equal((shrinkValue(value, 10, 100) as { truncated?: boolean }).truncated, undefined);
    });

    it('bounds pathologically deep input instead of recursing forever', () => {
      let deep: SerializedValue = num(1);
      for (let i = 0; i < 5_000; i++) {
        deep = { k: 'array', entries: [deep], length: 1 };
      }
      assert.doesNotThrow(() => shrinkValue(deep, 5, 100));
    });
  });
});
