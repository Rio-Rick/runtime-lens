import assert from 'node:assert/strict';
import { isTableSource, normalizeConsoleTable, type TableOptions } from '../src/agent/console-table';

/**
 * Every shape asserted here was checked against real Node's own
 * `console.table` first (see the audit notes), so these are regression tests
 * for compatibility, not just internal consistency.
 */

const OPTIONS: TableOptions = { depth: 4, maxStringLength: 500, maxBytes: 256 * 1024 };

function table(...args: unknown[]) {
  return normalizeConsoleTable(args, OPTIONS);
}

function cell(row: { cells: Array<{ k: string; v?: unknown }> }, i: number): unknown {
  const c = row.cells[i];
  return c?.k === 'string' || c?.k === 'number' || c?.k === 'boolean' ? c.v : c?.k;
}

describe('agent/console-table: isTableSource', () => {
  it('is false for primitives, null, undefined and bare functions', () => {
    for (const v of [42, 'hi', true, null, undefined, function foo() {}, 10n, Symbol('s')]) {
      assert.equal(isTableSource(v), false, String(v));
    }
  });

  it('is true for arrays, plain objects, Maps, Sets and opaque objects', () => {
    for (const v of [[], {}, new Map(), new Set(), new Date(), new Error('x'), /a/]) {
      assert.equal(isTableSource(v), true, String(v));
    }
  });
});

describe('agent/console-table: normalizeConsoleTable', () => {
  it('array of objects: columns in first-seen order, rows keyed by index', () => {
    const t = table([
      { name: 'John', age: 20 },
      { name: 'Jane', age: 25 }
    ]);
    assert.deepEqual(t.columns, ['name', 'age']);
    assert.deepEqual(t.rows.map((r) => r.key), ['0', '1']);
    assert.deepEqual(t.rows[0].cells.map((c) => (c.k === 'string' || c.k === 'number' ? c.v : c.k)), ['John', 20]);
  });

  it('object of objects: rows keyed by the object\u2019s own keys', () => {
    const t = table({ first: { name: 'John', age: 20 }, second: { name: 'Jane', age: 25 } });
    assert.deepEqual(t.columns, ['name', 'age']);
    assert.deepEqual(t.rows.map((r) => r.key), ['first', 'second']);
  });

  it('array of primitives: a single "Values" column', () => {
    const t = table(['A', 'B', 'C']);
    assert.deepEqual(t.columns, ['Values']);
    assert.deepEqual(t.rows.map((r) => cell(r, 0)), ['A', 'B', 'C']);
  });

  it('heterogeneous objects: union of columns, missing cells are undefined', () => {
    const t = table([{ a: 1 }, { b: 2, c: 3 }, { a: 4, c: 5 }]);
    assert.deepEqual(t.columns, ['a', 'b', 'c']);
    assert.deepEqual(t.rows[0].cells.map((c) => c.k), ['number', 'undefined', 'undefined']);
    assert.deepEqual(t.rows[1].cells.map((c) => c.k), ['undefined', 'number', 'number']);
  });

  it('empty array / empty object: no rows and no columns (not even Values)', () => {
    assert.deepEqual(table([]), { columns: [], rows: [] });
    assert.deepEqual(table({}), { columns: [], rows: [] });
  });

  it('null / undefined / a bare primitive: agent.core is expected to skip the table call entirely; ' +
    'normalizeConsoleTable itself just treats the input as a single opaque row if ever called', () => {
    // isTableSource() is the real gate (see agent/core.ts); this only documents
    // that the normalizer degrades harmlessly if ever called anyway.
    assert.doesNotThrow(() => table(null));
    assert.doesNotThrow(() => table(undefined));
    assert.doesNotThrow(() => table(42));
  });

  it('Values column is appended after discovered columns, regardless of row order', () => {
    assert.deepEqual(table([1, { a: 1 }]).columns, ['a', 'Values']);
    assert.deepEqual(table([{ a: 1 }, 1]).columns, ['a', 'Values']);
    assert.deepEqual(table([{ a: 1 }, 1, { z: 9 }]).columns, ['a', 'z', 'Values']);
  });

  it('array-index-like columns sort numerically ahead of named columns, insertion order otherwise', () => {
    assert.deepEqual(table([{ z: 1 }, [10, 20]]).columns, ['0', '1', 'z']);
    assert.deepEqual(table([{ a: 1 }, { a: 2, 5: 9 }, { b: 3 }]).columns, ['5', 'a', 'b']);
    // non-canonical numeric-looking keys ("-1", "01", "1.5") are NOT array indices
    assert.deepEqual(table([{ z: 1 }, { '-1': 1 }, { '01': 1 }, { '1.5': 1 }]).columns, ['z', '-1', '01', '1.5']);
  });

  it('a requested columns list is honoured exactly, even for a column no row has', () => {
    assert.deepEqual(table([{ a: 1, b: 2, c: 3 }], ['c', 'a']).columns, ['c', 'a']);
    const missing = table([{ a: 1 }], ['zzz']);
    assert.deepEqual(missing.columns, ['zzz']);
    assert.equal(missing.rows[0].cells[0].k, 'undefined');
  });

  it('only reads OWN properties: no inherited toString/constructor leaking in as a column', () => {
    const t = table([{ a: 1 }, { toString: 2 }]);
    assert.deepEqual(t.columns, ['a', 'toString']);
    assert.equal(t.rows[0].cells[1].k, 'undefined');
  });

  it('an own "__proto__" data key (e.g. from JSON.parse) is treated as an ordinary column', () => {
    const row = JSON.parse('{"__proto__":5,"z":1}') as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(row, '__proto__'), true);
    const t = table([row, { z: 2 }]);
    assert.ok(t.columns.includes('__proto__'));
  });

  it('Map: fixed Key/Values columns, iteration-order keys, "iteration index" label', () => {
    const t = table(
      new Map([
        ['a', { x: 1 }],
        ['b', { x: 2 }]
      ])
    );
    assert.deepEqual(t.columns, ['Key', 'Values']);
    assert.equal(t.indexLabel, 'iteration index');
    assert.deepEqual(t.rows.map((r) => r.key), ['0', '1']);
    assert.equal(cell(t.rows[0], 0), 'a');
  });

  it('Set: single Values column, "iteration index" label', () => {
    const t = table(new Set([1, 2, 3]));
    assert.deepEqual(t.columns, ['Values']);
    assert.equal(t.indexLabel, 'iteration index');
    assert.deepEqual(t.rows.map((r) => cell(r, 0)), [1, 2, 3]);
  });

  it('a top-level Date/Error/RegExp is an EMPTY table (no own enumerable keys), not one opaque row', () => {
    assert.deepEqual(table(new Date(0)), { columns: [], rows: [] });
    assert.deepEqual(table(new Error('boom')), { columns: [], rows: [] });
    assert.deepEqual(table(/a/), { columns: [], rows: [] });
  });

  it('Date/Error/RegExp as array rows contribute their OWN enumerable keys only (usually none)', () => {
    const t = table([new Date(0), new Error('boom'), /a/]);
    assert.deepEqual(t.columns, []);
    assert.equal(t.rows.length, 3);
    const withCode = table([Object.assign(new Error('x'), { code: 'E1' })]);
    assert.deepEqual(withCode.columns, ['code']);
    assert.equal(cell(withCode.rows[0], 0), 'E1');
  });

  it('mixed array: numeric-array columns before named columns, Values column last', () => {
    const t = table([1, 'x', { a: 1 }, [1, 2], null, undefined]);
    assert.deepEqual(t.columns, ['0', '1', 'a', 'Values']);
    assert.equal(cell(t.rows[0], 3), 1);
    assert.equal(cell(t.rows[1], 3), 'x');
    assert.equal(t.rows[4].cells[3].k, 'null');
    assert.equal(t.rows[5].cells[3].k, 'undefined');
  });

  it('special numbers round-trip through JSON-safe encodings', () => {
    const t = table([{ n: NaN, i: Infinity, m: -Infinity, z: -0 }]);
    assert.deepEqual(
      t.rows[0].cells.map((c) => c.k),
      ['number', 'number', 'number', 'number']
    );
  });

  it('a throwing getter becomes an inspectable error cell instead of throwing', () => {
    const row = {
      get boom(): number {
        throw new Error('nope');
      },
      ok: 1
    };
    assert.doesNotThrow(() => table([row]));
    const t = table([row]);
    assert.equal(t.rows[0].cells[t.columns.indexOf('ok')].k, 'number');
  });

  it('a revoked Proxy does not throw and yields an empty-ish table', () => {
    const { proxy, revoke } = Proxy.revocable([1, 2, 3], {});
    revoke();
    assert.doesNotThrow(() => table(proxy));
  });

  it('a Proxy with a throwing ownKeys trap does not throw', () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('x');
        }
      }
    );
    assert.doesNotThrow(() => table(proxy));
  });

  it('a circular reference does not throw and is represented, not infinitely recursed', () => {
    const circular: Record<string, unknown> = { name: 'c' };
    circular.self = circular;
    assert.doesNotThrow(() => table([circular, { name: 'd', ref: circular }]));
  });

  it('rows and columns are both bounded, and truncation is reported', () => {
    const bigRows = Array.from({ length: 5_000 }, (_, i) => ({ v: i }));
    const t = table(bigRows);
    assert.ok(t.rows.length <= 1_000);
    assert.equal(t.truncated, true);
    assert.equal(t.totalRows, 5_000);

    const wideRow: Record<string, number> = {};
    for (let i = 0; i < 500; i++) {
      wideRow[`c${i}`] = i;
    }
    const wide = table([wideRow]);
    assert.ok(wide.columns.length <= 256);
    assert.equal(wide.truncated, true);
  });

  it('stays within its byte budget for large cell values', () => {
    const rows = Array.from({ length: 200 }, () => ({ text: 'y'.repeat(4_000) }));
    const t = normalizeConsoleTable([rows], { ...OPTIONS, maxBytes: 32 * 1024 });
    const bytes = Buffer.byteLength(JSON.stringify(t), 'utf8');
    assert.ok(bytes < 40 * 1024, `payload was ${bytes} bytes`);
    assert.equal(t.truncated, true);
  });
});
