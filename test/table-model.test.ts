import assert from 'node:assert/strict';
import type { ConsoleTablePayload, SerializedValue } from '../src/protocol';
import {
  INDEX_COLUMN,
  buildTableModel,
  buildTsv,
  cellText,
  filterRows,
  sortRows,
  windowRange
} from '../src/webview/table-model';

const S = (v: string): SerializedValue => ({ k: 'string', v });
const N = (v: number): SerializedValue => ({ k: 'number', v });
const B = (v: boolean): SerializedValue => ({ k: 'boolean', v });

function payload(rows: Array<{ key: string; cells: SerializedValue[] }>, columns: string[]): ConsoleTablePayload {
  return { columns, rows };
}

describe('webview/table-model', () => {
  const table = payload(
    [
      { key: '0', cells: [S('Ada'), N(36)] },
      { key: '1', cells: [S('Linus'), N(54)] },
      { key: '2', cells: [S('Grace'), N(85)] }
    ],
    ['name', 'age']
  );

  describe('filterRows', () => {
    it('an empty query keeps every row, in source order', () => {
      const model = buildTableModel(table);
      assert.deepEqual(filterRows(model, ''), [0, 1, 2]);
    });

    it('matches case-insensitively across any column, including the row key', () => {
      const model = buildTableModel(table);
      assert.deepEqual(filterRows(model, 'ADA'), [0]);
      assert.deepEqual(filterRows(model, '54'), [1]);
    });

    it('matches the implicit row key too', () => {
      const model = buildTableModel(payload([{ key: 'unusual-key', cells: [N(1)] }], ['v']));
      assert.deepEqual(filterRows(model, 'unusual'), [0]);
    });

    it('returns nothing for a query that matches no row', () => {
      const model = buildTableModel(table);
      assert.deepEqual(filterRows(model, 'zzz'), []);
    });
  });

  describe('sortRows', () => {
    it('sorts numeric columns numerically, not lexicographically', () => {
      const model = buildTableModel(table);
      const sorted = sortRows(model, [0, 1, 2], { column: 1, direction: 'asc' });
      assert.deepEqual(
        sorted.map((i) => table.rows[i].key),
        ['0', '1', '2']
      ); // 36, 54, 85 already ascending
      const desc = sortRows(model, [0, 1, 2], { column: 1, direction: 'desc' });
      assert.deepEqual(
        desc.map((i) => table.rows[i].key),
        ['2', '1', '0']
      );
    });

    it('sorts string columns case-insensitively', () => {
      const model = buildTableModel(table);
      const sorted = sortRows(model, [0, 1, 2], { column: 0, direction: 'asc' });
      assert.deepEqual(
        sorted.map((i) => table.rows[i].key),
        ['0', '2', '1'] // Ada, Grace, Linus
      );
    });

    it('sorting by the (index) column uses the row key', () => {
      const model = buildTableModel(table);
      const sorted = sortRows(model, [2, 0, 1], { column: INDEX_COLUMN, direction: 'asc' });
      assert.deepEqual(
        sorted.map((i) => table.rows[i].key),
        ['0', '1', '2']
      );
    });

    it('null sort spec is a no-op that preserves order', () => {
      const model = buildTableModel(table);
      assert.deepEqual(sortRows(model, [2, 0, 1], null), [2, 0, 1]);
    });

    it('numbers sort ahead of text, and NaN sorts last', () => {
      const mixed = payload(
        [
          { key: '0', cells: [S('x')] },
          { key: '1', cells: [N(5)] },
          { key: '2', cells: [N(NaN)] },
          { key: '3', cells: [N(1)] }
        ],
        ['v']
      );
      const model = buildTableModel(mixed);
      const sorted = sortRows(model, [0, 1, 2, 3], { column: 0, direction: 'asc' });
      assert.deepEqual(
        sorted.map((i) => mixed.rows[i].key),
        ['3', '1', '2', '0']
      );
    });

    it('ties keep source order (stable sort)', () => {
      const tied = payload(
        [
          { key: 'a', cells: [N(1)] },
          { key: 'b', cells: [N(1)] },
          { key: 'c', cells: [N(1)] }
        ],
        ['v']
      );
      const model = buildTableModel(tied);
      const sorted = sortRows(model, [0, 1, 2], { column: 0, direction: 'asc' });
      assert.deepEqual(
        sorted.map((i) => tied.rows[i].key),
        ['a', 'b', 'c']
      );
    });
  });

  describe('cellText', () => {
    it('renders every scalar kind readably', () => {
      assert.equal(cellText(S('hi')), 'hi');
      assert.equal(cellText(N(42)), '42');
      assert.equal(cellText(B(true)), 'true');
      assert.equal(cellText({ k: 'null' }), 'null');
      assert.equal(cellText({ k: 'undefined' }), 'undefined');
      assert.equal(cellText(undefined), 'undefined');
    });

    it('truncates very long strings instead of blowing up the layout', () => {
      const text = cellText(S('x'.repeat(1000)));
      assert.ok(text.length <= 501, `expected a truncated string, got ${text.length} chars`);
      assert.ok(text.endsWith('…'));
    });
  });

  describe('buildTsv', () => {
    it('produces a header row plus one tab-separated row per entry', () => {
      const model = buildTableModel(table);
      const tsv = buildTsv(model, [0, 1]);
      const lines = tsv.split('\n');
      assert.equal(lines[0], '(index)\tname\tage');
      assert.equal(lines[1], '0\tAda\t36');
      assert.equal(lines[2], '1\tLinus\t54');
      assert.equal(lines.length, 3);
    });

    it('flattens embedded tabs/newlines so the TSV stays well-formed', () => {
      const dirty = payload([{ key: '0', cells: [S('a\tb\nc')] }], ['v']);
      const model = buildTableModel(dirty);
      const tsv = buildTsv(model, [0]);
      assert.equal(tsv.split('\n').length, 2, 'the embedded newline must not create an extra row');
      assert.ok(!tsv.includes('a\tb\nc'));
    });
  });

  describe('windowRange', () => {
    it('returns the full range when the viewport covers every row', () => {
      const range = windowRange({ scrollTop: 0, viewportHeight: 1000, rowHeight: 24, total: 10, overscan: 0 });
      assert.deepEqual(range, { start: 0, end: 10 });
    });

    it('windows to roughly the visible rows plus overscan when scrolled', () => {
      const range = windowRange({ scrollTop: 2400, viewportHeight: 240, rowHeight: 24, total: 1000, overscan: 5 });
      assert.equal(range.start, 95); // row 100 first visible, minus 5 overscan
      assert.ok(range.end > range.start && range.end <= 1000);
    });

    it('clamps to [0, total] instead of running past either end', () => {
      const atStart = windowRange({ scrollTop: 0, viewportHeight: 240, rowHeight: 24, total: 5 });
      assert.equal(atStart.start, 0);
      const atEnd = windowRange({ scrollTop: 100_000, viewportHeight: 240, rowHeight: 24, total: 5 });
      assert.equal(atEnd.end, 5);
    });

    it('degenerates to an empty range for zero rows instead of dividing oddly', () => {
      assert.deepEqual(windowRange({ scrollTop: 0, viewportHeight: 240, rowHeight: 24, total: 0 }), { start: 0, end: 0 });
    });
  });
});
