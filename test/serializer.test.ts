import assert from 'node:assert/strict';
import { DEFAULT_SERIALIZE_OPTIONS, serialize } from '../src/serialization/serializer';
import { preview, previewArgs, toPlainText, truncate } from '../src/serialization/preview';
import type { SerializedValue } from '../src/protocol';

function k(value: unknown, opts = {}): string {
  return serialize(value, opts).k;
}

describe('serialization/serializer', () => {
  it('serializes primitives', () => {
    assert.deepEqual(serialize('hi'), { k: 'string', v: 'hi', length: 2 });
    assert.deepEqual(serialize(42), { k: 'number', v: 42 });
    assert.deepEqual(serialize(true), { k: 'boolean', v: true });
    assert.deepEqual(serialize(false), { k: 'boolean', v: false });
    assert.deepEqual(serialize(null), { k: 'null' });
    assert.deepEqual(serialize(undefined), { k: 'undefined' });
  });

  it('encodes non-finite numbers as tagged strings so JSON stays lossless', () => {
    assert.deepEqual(serialize(NaN), { k: 'number', v: 'NaN' });
    assert.deepEqual(serialize(Infinity), { k: 'number', v: 'Infinity' });
    assert.deepEqual(serialize(-Infinity), { k: 'number', v: '-Infinity' });
    const round = JSON.parse(JSON.stringify(serialize(NaN))) as { k: string; v: string };
    assert.equal(round.v, 'NaN', 'JSON.stringify(NaN) would have produced null');
  });

  it('serializes bigint, symbol, date and regexp', () => {
    assert.deepEqual(serialize(10n), { k: 'bigint', v: '10n' });
    const sym = serialize(Symbol('tag'));
    assert.equal(sym.k, 'symbol');
    assert.match(String((sym as { v: string }).v), /tag/);
    assert.deepEqual(serialize(new Date('2026-01-01T00:00:00.000Z')), {
      k: 'date',
      v: '2026-01-01T00:00:00.000Z'
    });
    assert.deepEqual(serialize(new Date('nope')), { k: 'date', v: 'Invalid Date' });
    assert.deepEqual(serialize(/ab+c/gi), { k: 'regexp', v: '/ab+c/gi' });
  });

  it('serializes arrays with element types and truncation', () => {
    const out = serialize([1, 'two', null]) as { k: string; entries: SerializedValue[]; length: number };
    assert.equal(out.k, 'array');
    assert.equal(out.length, 3);
    assert.deepEqual(out.entries.map((i) => i.k), ['number', 'string', 'null']);

    const big = serialize(Array.from({ length: 250 }, (_, i) => i), { maxEntries: 10 }) as {
      entries: SerializedValue[];
      length: number;
      truncated?: boolean;
    };
    assert.equal(big.length, 250);
    assert.equal(big.entries.length, 10);
    assert.equal(big.truncated, true);
  });

  it('serializes nested plain objects and records the constructor name', () => {
    class Point {
      constructor(public x: number, public y: number) {}
    }
    const out = serialize({ a: { b: { c: 1 } }, p: new Point(1, 2) }) as {
      k: string;
      entries: Array<[string, SerializedValue]>;
    };
    assert.equal(out.k, 'object');
    const p = out.entries.find(([key]) => key === 'p')![1] as { ctor?: string };
    assert.equal(p.ctor, 'Point');
    const a = out.entries.find(([key]) => key === 'a')![1] as { entries: Array<[string, SerializedValue]> };
    assert.equal(a.entries[0][0], 'b');
  });

  it('honours the configured object depth', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: 'bottom' } } } } };
    const shallow = serialize(deep, { depth: 1 });
    const text = JSON.stringify(shallow);
    assert.ok(text.includes('maxdepth'), text);
    assert.ok(!text.includes('bottom'));

    const deeper = JSON.stringify(serialize(deep, { depth: 6 }));
    assert.ok(deeper.includes('bottom'));
  });

  it('serializes Map and Set including non-string keys', () => {
    const map = serialize(new Map<unknown, unknown>([['a', 1], [2, 'two']])) as {
      k: string;
      size: number;
      entries: Array<[SerializedValue, SerializedValue]>;
    };
    assert.equal(map.k, 'map');
    assert.equal(map.size, 2);
    assert.equal(map.entries[1][0].k, 'number');

    const set = serialize(new Set(['x', 'y'])) as { k: string; size: number; entries: SerializedValue[] };
    assert.equal(set.k, 'set');
    assert.equal(set.size, 2);
    assert.equal(set.entries.length, 2);
  });

  it('marks weak collections and promises, and flattens typed arrays', () => {
    const weakMap = serialize(new WeakMap()) as { k: string; hint: string };
    assert.equal(weakMap.k, 'unserializable');
    assert.match(weakMap.hint, /WeakMap/);
    assert.equal(k(new WeakSet()), 'unserializable');
    const promise = serialize(Promise.resolve(1)) as { k: string; hint: string };
    assert.equal(promise.k, 'unserializable');
    assert.match(promise.hint, /Promise/);
    const ta = serialize(new Uint8Array([1, 2, 3])) as { k: string; length?: number; entries: SerializedValue[] };
    assert.equal(ta.k, 'array');
    assert.equal(ta.length, 3);
    assert.deepEqual(ta.entries.map((e) => (e as { v: number }).v), [1, 2, 3]);
  });

  it('serializes errors with name, message, stack and own properties', () => {
    const err = new TypeError('boom');
    (err as unknown as { code: string }).code = 'E_BOOM';
    const out = serialize(err) as {
      k: string;
      name: string;
      message: string;
      stack?: string;
      props?: Record<string, SerializedValue>;
    };
    assert.equal(out.k, 'error');
    assert.equal(out.name, 'TypeError');
    assert.equal(out.message, 'boom');
    assert.match(String(out.stack), /TypeError: boom/);
    assert.deepEqual(out.props?.code, { k: 'string', v: 'E_BOOM', length: 6 });

    const noStack = serialize(err, { includeStack: false }) as { stack?: string };
    assert.equal(noStack.stack, undefined);
  });

  it('serializes functions and classes by shape, never by invoking them', () => {
    let called = false;
    function named(_a: unknown, _b: unknown) {
      called = true;
      return 1;
    }
    const out = serialize(named) as { k: string; name?: string; arity?: number };
    assert.equal(out.k, 'function');
    assert.equal(out.name, 'named');
    assert.equal(out.arity, 2);
    assert.equal(called, false);

    assert.equal(k(() => 1), 'function');
    assert.equal(k(async function* g() {}), 'function');
    assert.equal(k(class Foo {}), 'function');
  });

  it('detects circular references and reports the path of the first sighting', () => {
    const root: Record<string, unknown> = { name: 'root' };
    root.self = root;
    root.nested = { back: root };
    const out = serialize(root) as { entries: Array<[string, SerializedValue]> };
    const self = out.entries.find(([key]) => key === 'self')![1] as { k: string; path?: string };
    assert.equal(self.k, 'circular');
    assert.ok(typeof self.path === 'string');
    // Serialization must terminate and stay JSON-safe.
    assert.doesNotThrow(() => JSON.stringify(out));
  });

  it('handles mutually recursive structures and shared references', () => {
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b', a };
    a.b = b;
    const shared = { x: 1 };
    const out = serialize({ a, b, one: shared, two: shared });
    const text = JSON.stringify(out);
    assert.ok(text.includes('circular'));
    assert.ok(text.length < 20000);
  });

  it('caps long strings', () => {
    const long = 'x'.repeat(50_000);
    const out = serialize(long, { maxStringLength: 100 }) as { v: string; truncated?: boolean };
    assert.equal(out.v.length, 100);
    assert.equal(out.truncated, true);
  });

  it('caps the total node budget instead of exploding on huge graphs', () => {
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) {
      wide[`k${i}`] = { i, nested: { deeper: i } };
    }
    const out = serialize(wide, { maxNodes: 200, maxEntries: 1000, depth: 5 });
    const text = JSON.stringify(out);
    assert.ok(text.includes('budget') || text.includes('truncated'), 'expected a budget marker');
    assert.ok(text.length < 200_000);
  });

  it('never throws on hostile objects', () => {
    const hostile = {
      get boom(): never {
        throw new Error('getter exploded');
      },
      toJSON() {
        throw new Error('toJSON exploded');
      }
    };
    let out: SerializedValue | undefined;
    assert.doesNotThrow(() => {
      out = serialize(hostile);
    });
    assert.match(JSON.stringify(out), /throwing getter/);

    const nullProto = Object.create(null) as Record<string, unknown>;
    nullProto.a = 1;
    assert.equal(serialize(nullProto).k, 'object');

    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('nope');
        }
      }
    );
    assert.doesNotThrow(() => serialize(proxy));
  });

  it('exposes sane defaults', () => {
    assert.equal(DEFAULT_SERIALIZE_OPTIONS.depth, 3);
    assert.ok(DEFAULT_SERIALIZE_OPTIONS.maxStringLength >= 1000);
    assert.ok(DEFAULT_SERIALIZE_OPTIONS.maxNodes >= 1000);
  });
});

describe('serialization/preview', () => {
  it('renders compact one-line previews', () => {
    assert.equal(preview(serialize('hi')), "'hi'");
    assert.equal(preview(serialize(1)), '1');
    assert.equal(preview(serialize(null)), 'null');
    assert.equal(preview(serialize(undefined)), 'undefined');
    assert.equal(preview(serialize(10n)), '10n');
    assert.match(preview(serialize(new Date('2026-01-01T00:00:00.000Z'))), /^Date\(2026-01-01/);
    assert.equal(preview(serialize([1, 2])), '[1, 2]');
    assert.equal(preview(serialize({ a: 1 })), '{ a: 1 }');
    assert.equal(preview(serialize(new Set([1]))), 'Set(1) {1}');
    assert.equal(preview(serialize(new Map([['a', 1]]))), "Map(1) {'a' => 1}");
    assert.match(preview(serialize(new Error('x'))), /Error: x/);
    assert.match(preview(serialize(function foo() {})), /foo/);
  });

  it('joins multiple console arguments', () => {
    const text = previewArgs([serialize('count'), serialize(3), serialize({ ok: true })]);
    assert.equal(text, 'count 3 { ok: true }', 'top-level strings print bare, like devtools');
  });

  it('truncates with an ellipsis at the requested length', () => {
    assert.equal(truncate('abcdefghij', 5), 'abcd…');
    assert.equal(truncate('abc', 5), 'abc');
  });

  it('renders a plain-text tree for copying', () => {
    const text = toPlainText(serialize({ a: [1, { b: 2 }] }));
    assert.ok(text.includes('a'));
    assert.ok(text.includes('b'));
  });
});
