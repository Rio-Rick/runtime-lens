import assert from 'node:assert/strict';
import type { SerializedValue } from '../src/protocol';
import { parseHostMessage, type DetailMessage } from '../src/webview/messages';
import { initialState, reduce } from '../src/webview/view-state';

const num = (v: number): SerializedValue => ({ k: 'number', v });
const obj = (entries: Array<[string, SerializedValue]>): SerializedValue => ({ k: 'object', entries, size: entries.length });

function detail(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'detail', key: 7, detail: 'plain text', ...extra };
}

function parsed(raw: unknown): DetailMessage {
  const message = parseHostMessage(raw);
  assert.ok(message && message.type === 'detail', 'expected a detail message');
  return message;
}

describe('webview/messages: structured detail', () => {
  it('passes an ordinary detail message through untouched (same object, no new fields)', () => {
    const raw = detail();
    assert.equal(parseHostMessage(raw), raw);
  });

  it('keeps a table detail message exactly as before', () => {
    const raw = { type: 'detail', key: 1, detail: '', table: { columns: ['a'], rows: [] } };
    assert.equal(parseHostMessage(raw), raw);
  });

  it('accepts valid structured values and the probed expression', () => {
    const values = [obj([['a', num(1)]]), { k: 'string', v: '{"x":1}' } as SerializedValue];
    const message = parsed(detail({ values, expr: 'user' }));
    assert.deepEqual(message.values, values);
    assert.equal(message.expr, 'user');
    assert.equal(message.detail, 'plain text');
    assert.equal(message.key, 7);
  });

  it('drops malformed values but still accepts the message and its plain-text detail', () => {
    for (const bad of [
      [{ k: 'nope' }],
      [{ k: 'object', entries: 'x', size: 1 }],
      [{ k: 'array', entries: [{ k: 'number', v: 'oops' }], length: 1 }],
      [null],
      'not an array',
      {},
      42,
      []
    ]) {
      const message = parsed(detail({ values: bad, expr: 'x' }));
      assert.equal(message.values, undefined, JSON.stringify(bad));
      assert.equal(message.expr, undefined, JSON.stringify(bad));
      assert.equal(message.detail, 'plain text');
    }
  });

  it('drops values nested deeper than the protocol allows', () => {
    let deep: SerializedValue = num(1);
    for (let i = 0; i < 40; i++) {
      deep = { k: 'array', entries: [deep], length: 1 };
    }
    assert.equal(parsed(detail({ values: [deep] })).values, undefined);
  });

  it('drops an unreasonable number of values', () => {
    assert.equal(parsed(detail({ values: Array.from({ length: 65 }, () => num(1)) })).values, undefined);
    assert.equal(parsed(detail({ values: Array.from({ length: 64 }, () => num(1)) })).values?.length, 64);
  });

  it('ignores an expression that arrives without valid values, or is not a string', () => {
    assert.equal(parsed(detail({ expr: 'orphan' })).expr, undefined);
    assert.equal(parsed(detail({ values: [num(1)], expr: 42 })).expr, undefined);
    assert.equal(parsed(detail({ values: [num(1)], expr: 'x'.repeat(5_000) })).expr, undefined);
  });

  it('still rejects a detail message whose required fields are wrong', () => {
    assert.equal(parseHostMessage(detail({ key: 'x' })), undefined);
    assert.equal(parseHostMessage(detail({ detail: 5 })), undefined);
    assert.equal(parseHostMessage({ type: 'detail', key: 1 }), undefined);
  });

  it('is cached by the view state without being copied, so the tree plan is not recomputed', () => {
    const message = parsed(detail({ values: [obj([['a', num(1)]])] }));
    const state = reduce(initialState(), {
      type: 'snapshot',
      message: {
        type: 'snapshot',
        events: [{ key: 7, index: 1, kind: 'log', level: 'log', text: 't', file: '/a.ts', short: 'a.ts', line: 1, count: 1, ts: 1, remapped: false }],
        follow: true,
        paused: false,
        filter: '',
        stats: { size: 1, capacity: 10, dropped: 0, totalAdded: 1 }
      }
    });
    const next = reduce(state, { type: 'detail', message });
    assert.equal(next.details.get(7), message);
  });
});
