import type { ConsoleTablePayload, ConsoleTableRow, SerializedValue } from '../protocol';
import { preview, toPlainText } from '../serialization/preview';

/**
 * Pure view-model for the console.table grid. Everything expensive here is
 * computed once per payload (or once per sort column) rather than once per
 * keystroke or render, and nothing touches the DOM, so it is unit-testable.
 */

/** Column id of the implicit `(index)` column. Data columns use their position. */
export const INDEX_COLUMN = -1;

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  column: number;
  direction: SortDirection;
}

export interface TableModel {
  readonly columns: readonly string[];
  readonly rows: readonly ConsoleTableRow[];
  /** Lower-cased searchable text of row `i`. Built on first use, then cached. */
  haystack(): readonly string[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const CELL_PREVIEW = { maxLength: 500, depth: 3, quoteStrings: false } as const;
const SEARCH_PREVIEW = { maxLength: 200, depth: 2, quoteStrings: false } as const;

/** One-line display text of a cell. */
export function cellText(value: SerializedValue | undefined): string {
  if (value === undefined) {
    return 'undefined';
  }
  // Fast paths: most cells are scalars, and this runs for every visible cell.
  switch (value.k) {
    case 'string':
      return value.v.length > 500 ? `${value.v.slice(0, 499)}…` : value.v;
    case 'number':
      return String(value.v);
    case 'boolean':
      return value.v ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    default:
      return preview(value, CELL_PREVIEW);
  }
}

/** Full, multi-line text of a cell for the inspector (bounded). */
export function cellDetail(value: SerializedValue | undefined, maxLength = 20_000): string {
  if (value === undefined) {
    return 'undefined';
  }
  const text = value.k === 'string' ? value.v : toPlainText(value);
  const note = value.k === 'string' && value.truncated ? `\n… (truncated; original length ${value.length ?? '?'})` : '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n… (${text.length - maxLength} more characters)` : text + note;
}

export function buildTableModel(payload: ConsoleTablePayload): TableModel {
  let cache: string[] | undefined;
  return {
    columns: payload.columns,
    rows: payload.rows,
    haystack(): readonly string[] {
      if (!cache) {
        cache = payload.rows.map((row) => {
          const parts = [row.key];
          for (const cell of row.cells) {
            parts.push(
              cell.k === 'string' || cell.k === 'number' || cell.k === 'boolean' ? cellText(cell) : preview(cell, SEARCH_PREVIEW)
            );
          }
          return parts.join('\u0001').toLowerCase();
        });
      }
      return cache;
    }
  };
}

/** Indices of the rows matching `query` (substring, case-insensitive), in source order. */
export function filterRows(model: TableModel, query: string): number[] {
  const count = model.rows.length;
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return Array.from({ length: count }, (_, i) => i);
  }
  const haystack = model.haystack();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (haystack[i].includes(needle)) {
      out.push(i);
    }
  }
  return out;
}

interface SortKey {
  n: number | undefined;
  s: string;
}

function keyOf(value: SerializedValue | undefined): SortKey {
  if (value?.k === 'number') {
    return { n: Number(value.v), s: '' };
  }
  return { n: undefined, s: cellText(value) };
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.n !== undefined && b.n !== undefined) {
    if (Number.isNaN(a.n) || Number.isNaN(b.n)) {
      return Number.isNaN(a.n) === Number.isNaN(b.n) ? 0 : Number.isNaN(a.n) ? 1 : -1; // NaN last
    }
    return a.n === b.n ? 0 : a.n < b.n ? -1 : 1;
  }
  if (a.n !== undefined || b.n !== undefined) {
    return a.n !== undefined ? -1 : 1; // numbers before text
  }
  return collator.compare(a.s, b.s);
}

/**
 * Sort `indices` (a subset of row positions) by one column. Sort keys are
 * computed once per row instead of once per comparison, and ties keep source
 * order so the result is stable.
 */
export function sortRows(model: TableModel, indices: readonly number[], sort: SortSpec | null): number[] {
  if (!sort || (sort.column !== INDEX_COLUMN && (sort.column < 0 || sort.column >= model.columns.length))) {
    return [...indices];
  }
  const keys = new Map<number, SortKey>();
  for (const i of indices) {
    const row = model.rows[i];
    keys.set(i, sort.column === INDEX_COLUMN ? { n: undefined, s: row.key } : keyOf(row.cells[sort.column]));
  }
  const factor = sort.direction === 'asc' ? 1 : -1;
  return [...indices].sort((a, b) => {
    const result = compareKeys(keys.get(a) as SortKey, keys.get(b) as SortKey);
    return result !== 0 ? result * factor : a - b;
  });
}

/** Tab-separated text of the given rows, ready to paste into a spreadsheet. */
export function buildTsv(model: TableModel, indices: readonly number[]): string {
  const flat = (text: string): string => text.replace(/[\t\r\n]+/g, ' ');
  const lines = [['(index)', ...model.columns].map(flat).join('\t')];
  for (const i of indices) {
    const row = model.rows[i];
    lines.push([row.key, ...model.columns.map((_, c) => cellText(row.cells[c]))].map(flat).join('\t'));
  }
  return lines.join('\n');
}

export interface WindowInput {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  total: number;
  overscan?: number;
}

/** Which rows to actually put in the DOM: `[start, end)` plus a little overscan. */
export function windowRange({ scrollTop, viewportHeight, rowHeight, total, overscan = 8 }: WindowInput): {
  start: number;
  end: number;
} {
  if (total <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0 };
  }
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  return {
    start: Math.min(total, Math.max(0, first - overscan)),
    end: Math.min(total, first + visible + overscan)
  };
}

/** Below this many rows the grid renders everything: simpler, and find-in-page works. */
export const WINDOWING_THRESHOLD = 150;
