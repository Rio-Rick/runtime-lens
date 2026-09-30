import {
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  type ConsoleTablePayload,
  type ConsoleTableRow,
  type SerializedValue
} from '../protocol';
import { serialize } from '../serialization/serializer';
import { utf8ByteLength } from '../utils/bytes';

/**
 * Turns the arguments of `console.table(data, columns?)` into a bounded,
 * rectangular payload the Webview can sort/filter/render without knowing
 * anything about runtime object shapes.
 *
 * This runs inside the *user's* process, so it follows the agent's rules:
 *  - it never throws for hostile input (revoked Proxies, throwing getters);
 *  - it does a bounded amount of work: rows, columns, per-cell nodes and the
 *    total on-wire size are all capped, because a payload the server rejects
 *    takes the whole batch with it (and a WebSocket frame over the limit
 *    closes the connection);
 *  - it only reads *own* properties, so `{a: 1}` never shows the inherited
 *    `toString`/`constructor` for a column another row happens to define.
 */
export interface TableOptions {
  /** Nesting depth kept inside a cell (the agent's `objectDepth`). */
  depth: number;
  maxStringLength: number;
  /** Approximate JSON size budget for the whole payload, in bytes. */
  maxBytes: number;
}

/** Labels are clipped for display well below the validator's hard limit. */
const LABEL_MAX_LENGTH = 256;

/** Cells only need to be inspectable, not exhaustive; the budget bounds the rest. */
const CELL_MAX_ENTRIES = 50;
const CELL_MAX_NODES = 500;
const CELL_MAX_STRING = 2_000;
const CELL_MAX_BYTES = 8_192;

const VALUE_COLUMN = 'Values';

type SourceKind = 'array' | 'record' | 'map' | 'set' | 'primitive';

interface RowSource {
  key: string;
  source: unknown;
  /** Only for Map input: the row is a [key, value] pair with fixed columns. */
  pair?: readonly [unknown, unknown];
}

/**
 * Whether `console.table`'s first argument gets a grid at all. Real
 * `console.table` only builds one for arrays, plain objects, Maps and Sets;
 * anything else (a primitive, `null`, a bare function) is printed the same
 * way `console.log` would print it. Exported so the agent can decide, before
 * calling this at all, whether the event is really a table.
 */
export function isTableSource(value: unknown): boolean {
  return classify(value) !== 'primitive';
}

export function normalizeConsoleTable(args: unknown[], options: TableOptions): ConsoleTablePayload {
  const input = args[0];
  const requested = requestedColumns(args[1]);
  const kind = classify(input);

  const { rows, totalRows, fixedColumns, indexLabel } = collectRows(input, kind);
  const rowsTruncated = totalRows > rows.length;

  let rawColumns: string[];
  let columnsTruncated = false;
  let widest = 0;
  if (fixedColumns) {
    rawColumns = [...fixedColumns];
  } else {
    const discovered = discoverColumns(rows);
    rawColumns = discovered.columns;
    columnsTruncated = discovered.capped;
    widest = discovered.widest;
    if (requested) {
      // Native semantics: the requested columns, in the requested order —
      // including ones no row has — while primitive rows keep their Value column.
      rawColumns = [...(discovered.hasPrimitive ? [VALUE_COLUMN] : []), ...requested];
      columnsTruncated = false;
      widest = 0; // hiding columns on purpose is not truncation
    } else if (discovered.hasPrimitive) {
      // Matches real `console.table`: the Values column is appended after every
      // discovered object column, regardless of which row contributed it.
      rawColumns = [...rawColumns, VALUE_COLUMN].slice(0, TABLE_MAX_COLUMNS);
    }
  }

  let labels = makeLabels(rawColumns);
  // Column labels alone must not eat the budget: drop trailing columns first.
  let labelBytes = 0;
  const fit = labels.findIndex((label) => (labelBytes += utf8ByteLength(label) + 4) > options.maxBytes / 2);
  const labelsTruncated = fit >= 0;
  if (labelsTruncated) {
    labels = labels.slice(0, fit);
  }
  const cellOptions = {
    depth: options.depth,
    maxStringLength: Math.min(options.maxStringLength, CELL_MAX_STRING),
    maxEntries: CELL_MAX_ENTRIES,
    maxNodes: CELL_MAX_NODES
  };
  const cellByteCap = Math.min(CELL_MAX_BYTES, Math.max(64, Math.floor(options.maxBytes / 4)));

  let bytes = labels.reduce((sum, label) => sum + utf8ByteLength(label) + 4, 0);
  let columnCount = labels.length;
  let budgetHit = false;
  const outRows: ConsoleTableRow[] = [];

  rowLoop: for (const row of rows) {
    const key = clip(row.key);
    let rowBytes = utf8ByteLength(key) + 32;
    const cells: SerializedValue[] = [];
    for (let c = 0; c < columnCount; c++) {
      let cell = serialize(readCell(row, rawColumns[c]), cellOptions);
      let cellBytes = utf8ByteLength(JSON.stringify(cell)) + 1;
      if (cellBytes > cellByteCap) {
        cell = { k: 'unserializable', hint: `value too large to display (${cellBytes} bytes)` };
        cellBytes = utf8ByteLength(JSON.stringify(cell)) + 1;
      }
      if (bytes + rowBytes + cellBytes > options.maxBytes) {
        budgetHit = true;
        if (outRows.length === 0 && c > 0) {
          // Not even one full row fits: keep the columns that did, for every row.
          columnCount = c;
          bytes += rowBytes;
          outRows.push({ key, cells });
        }
        break rowLoop;
      }
      rowBytes += cellBytes;
      cells.push(cell);
    }
    bytes += rowBytes;
    outRows.push({ key, cells });
  }

  const finalLabels = labels.slice(0, columnCount);
  const truncated = rowsTruncated || columnsTruncated || labelsTruncated || budgetHit || columnCount < labels.length;
  const shownRows = outRows.length;
  const knownColumns = Math.max(widest, rawColumns.length);

  return {
    columns: finalLabels,
    rows: outRows,
    ...(truncated ? { truncated: true } : {}),
    ...(totalRows > shownRows ? { totalRows } : {}),
    ...(knownColumns > finalLabels.length ? { totalColumns: knownColumns } : {}),
    ...(indexLabel ? { indexLabel } : {})
  };
}

// ---------------------------------------------------------------- collection

function collectRows(
  input: unknown,
  kind: SourceKind
): { rows: RowSource[]; totalRows: number; fixedColumns?: readonly string[]; indexLabel?: string } {
  switch (kind) {
    case 'array': {
      const array = input as unknown[];
      const length = safeLength(array);
      const rows: RowSource[] = [];
      for (let i = 0; i < Math.min(length, TABLE_MAX_ROWS); i++) {
        rows.push({ key: String(i), source: readIndex(array, i) });
      }
      return { rows, totalRows: length };
    }
    case 'set': {
      const rows: RowSource[] = [];
      for (const value of safeIterate(input as Set<unknown>)) {
        rows.push({ key: String(rows.length), source: value });
        if (rows.length >= TABLE_MAX_ROWS) {
          break;
        }
      }
      return { rows, totalRows: Math.max(rows.length, safeSize(input as Set<unknown>)), indexLabel: 'iteration index' };
    }
    case 'map': {
      const rows: RowSource[] = [];
      for (const entry of safeIterate(input as Map<unknown, unknown>)) {
        rows.push({ key: String(rows.length), source: undefined, pair: [entry[0], entry[1]] });
        if (rows.length >= TABLE_MAX_ROWS) {
          break;
        }
      }
      return {
        rows,
        totalRows: Math.max(rows.length, safeSize(input as Map<unknown, unknown>)),
        fixedColumns: ['Key', VALUE_COLUMN],
        indexLabel: 'iteration index'
      };
    }
    case 'record': {
      const keys = safeKeys(input as object);
      const rows: RowSource[] = [];
      for (const key of keys.slice(0, TABLE_MAX_ROWS)) {
        rows.push({ key, source: readOwn(input as object, key) });
      }
      return { rows, totalRows: keys.length };
    }
    default:
      // isTableSource() is checked before this is ever called with a
      // primitive top-level value; a 'record' with zero own keys (an empty
      // object, or a Date/RegExp/Error/boxed-primitive with none) is the
      // only other way to land here, and it means a legitimately empty table.
      return { rows: [], totalRows: 0 };
  }
}

/**
 * True for a key JS treats as an array index ("0", "1", "23", but not "01",
 * "-1", "1.5", or anything ≥ 2**32-1): the ECMA-262 [[OwnPropertyKeys]] rule
 * that sorts these ahead of every other key regardless of insertion order.
 * `console.table`'s real output follows that rule (a plain accumulator
 * object built one row at a time reorders itself the same way), so matching
 * it is a correctness fix, not a cosmetic one.
 */
function isArrayIndexKey(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 2 ** 32 - 1;
}

function compareColumnKeys(a: string, b: string, order: ReadonlyMap<string, number>): number {
  const aIndex = isArrayIndexKey(a), bIndex = isArrayIndexKey(b);
  if (aIndex && bIndex) {
    return Number(a) - Number(b);
  }
  if (aIndex !== bIndex) {
    return aIndex ? -1 : 1;
  }
  return (order.get(a) ?? 0) - (order.get(b) ?? 0);
}

function discoverColumns(rows: readonly RowSource[]): {
  columns: string[];
  hasPrimitive: boolean;
  capped: boolean;
  widest: number;
} {
  const seen = new Set<string>();
  const insertionOrder = new Map<string, number>();
  const columns: string[] = [];
  let hasPrimitive = false;
  let capped = false;
  let widest = 0;

  for (const { source } of rows) {
    const kind = classify(source);
    let names: string[];
    if (kind === 'array') {
      const length = safeLength(source as unknown[]);
      widest = Math.max(widest, length);
      names = Array.from({ length: Math.min(length, TABLE_MAX_COLUMNS) }, (_, i) => String(i));
    } else if (kind === 'record') {
      const keys = safeKeys(source as object);
      widest = Math.max(widest, keys.length);
      names = keys.length > TABLE_MAX_COLUMNS ? keys.slice(0, TABLE_MAX_COLUMNS) : keys;
    } else {
      hasPrimitive = true;
      continue;
    }
    for (const name of names) {
      if (seen.has(name)) {
        continue;
      }
      if (columns.length >= TABLE_MAX_COLUMNS) {
        capped = true;
        break;
      }
      seen.add(name);
      insertionOrder.set(name, insertionOrder.size);
      columns.push(name);
    }
    if (widest > TABLE_MAX_COLUMNS) {
      capped = true;
    }
  }
  columns.sort((a, b) => compareColumnKeys(a, b, insertionOrder));
  return { columns, hasPrimitive, capped, widest };
}

function readCell(row: RowSource, column: string): unknown {
  if (row.pair) {
    return column === 'Key' ? row.pair[0] : row.pair[1];
  }
  if (classify(row.source) === 'array') {
    const index = Number(column);
    return Number.isInteger(index) && index >= 0 && String(index) === column
      ? readIndex(row.source as unknown[], index)
      : undefined;
  }
  if (classify(row.source) === 'record') {
    return readOwn(row.source as object, column);
  }
  // A primitive row (including a bare function, which console.table also
  // leaves blank rather than stringifying) only fills the Values column.
  return column === VALUE_COLUMN && typeof row.source !== 'function' ? row.source : undefined;
}

// ------------------------------------------------------------------- helpers

function requestedColumns(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && !seen.has(item)) {
      seen.add(item);
      out.push(item);
      if (out.length >= TABLE_MAX_COLUMNS) {
        break;
      }
    }
  }
  return out;
}

/** Clip to the validator's limit so one long key can't get a whole batch rejected. */
function clip(label: string): string {
  return label.length > LABEL_MAX_LENGTH ? `${label.slice(0, LABEL_MAX_LENGTH - 1)}…` : label;
}

function makeLabels(rawColumns: readonly string[]): string[] {
  const used = new Set<string>();
  return rawColumns.map((raw, index) => {
    let label = clip(raw);
    if (used.has(label)) {
      label = `${label.slice(0, LABEL_MAX_LENGTH - 12)}…#${index}`;
    }
    used.add(label);
    return label;
  });
}

// The `safe*` helpers below each guard one intrinsic operation that a hostile
// Proxy can make throw. They never swallow errors from user *data*.

function classify(value: unknown): SourceKind {
  if (value === null || typeof value !== 'object') {
    return 'primitive';
  }
  try {
    if (Array.isArray(value)) {
      return 'array';
    }
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    if (tag === 'Map') {
      return 'map';
    }
    if (tag === 'Set') {
      return 'set';
    }
    // Anything else — Date, RegExp, Error, a boxed primitive, a class
    // instance — is walked the same way a plain object would be: by its own
    // enumerable keys. That is what real `console.table` does too (an Error's
    // `message`/`stack` are non-enumerable, so it contributes no columns
    // unless the caller added one, e.g. `error.code`).
    return 'record';
  } catch {
    // A Proxy whose trap for `toString`/`Symbol.toStringTag` throws: still
    // walkable via `Object.keys` (which has its own guard), so 'record' is
    // the right fallback, not a dead end.
    return 'record';
  }
}

function safeKeys(value: object): string[] {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function safeLength(value: unknown[]): number {
  try {
    const length = value.length;
    return Number.isSafeInteger(length) && length > 0 ? length : 0;
  } catch {
    return 0;
  }
}

/**
 * Iterate a Map/Set, stopping quietly if a hostile iterator throws: the rows
 * read so far are still worth showing, and the user's own `console.table`
 * call (which runs afterwards) will surface the real error if there is one.
 */
function* safeIterate<T>(collection: Iterable<T>): Generator<T> {
  try {
    for (const value of collection) {
      yield value;
    }
  } catch {
    /* stop at the first failure */
  }
}

function safeSize(collection: { size: number }): number {
  try {
    const size = collection.size;
    return Number.isSafeInteger(size) && size > 0 ? size : 0;
  } catch {
    return 0;
  }
}

function readIndex(array: unknown[], index: number): unknown {
  try {
    return array[index];
  } catch (err) {
    return new Error(`<throwing index: ${errorMessage(err)}>`);
  }
}

/** Own-property read: absent keys are `undefined`, never an inherited member. */
function readOwn(object: object, key: string): unknown {
  try {
    if (!Object.prototype.hasOwnProperty.call(object, key)) {
      return undefined;
    }
    return (object as Record<string, unknown>)[key];
  } catch (err) {
    return new Error(`<throwing getter: ${errorMessage(err)}>`);
  }
}

function errorMessage(err: unknown): string {
  try {
    return (err instanceof Error ? err.message : String(err)).slice(0, 200);
  } catch {
    return 'unknown error';
  }
}
