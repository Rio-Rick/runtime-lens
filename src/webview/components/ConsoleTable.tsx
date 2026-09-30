import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleTablePayload, ConsoleTableRow } from '../../protocol';
import {
  INDEX_COLUMN,
  WINDOWING_THRESHOLD,
  buildTableModel,
  buildTsv,
  cellDetail,
  cellText,
  filterRows,
  sortRows,
  windowRange,
  type SortSpec
} from '../table-model';

export interface ConsoleTableProps {
  table: ConsoleTablePayload;
  /** Called with text to put on the clipboard (the host owns the clipboard). */
  onCopy: (text: string, label: string) => void;
}

const ROW_HEIGHT = 24; // keep in sync with --rl-row-h in style.css
const DEFAULT_WIDTH = 160;
const INDEX_WIDTH = 96;
const MIN_WIDTH = 60;

interface ResizeHandlers {
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void;
  onResizeMove: (event: React.PointerEvent<HTMLElement>) => void;
  onResizeEnd: () => void;
  onResizeKey: (event: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * Interactive grid for one `console.table` call.
 *
 * All per-payload work (search index, sort keys) lives in `table-model.ts` and
 * is memoised on the payload, so typing in the search box or scrolling never
 * re-walks the data. Rows are windowed once the table is large, so a
 * 1000 x 256 table puts a few dozen rows in the DOM instead of ~256,000 cells.
 * Columns are identified by *position*, never by name: property names such as
 * `(index)`, `Value` or `__proto__` can't collide with anything.
 */
export function ConsoleTable({ table, onCopy }: ConsoleTableProps): React.ReactElement {
  const model = useMemo(() => buildTableModel(table), [table]);
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [sort, setSort] = useState<SortSpec | null>(null);
  const [widths, setWidths] = useState<ReadonlyMap<number, number>>(new Map());
  const [inspected, setInspected] = useState<{ row: number; column: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const wrapRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ column: number; startX: number; startWidth: number } | null>(null);

  const filtered = useMemo(() => filterRows(model, deferredSearch), [model, deferredSearch]);
  const ordered = useMemo(() => sortRows(model, filtered, sort), [model, filtered, sort]);

  // Track the scroll container's height. The observer is disconnected on unmount.
  useEffect(() => {
    const element = wrapRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  // A new sort/filter can shrink the list below the current scroll position.
  useEffect(() => {
    if (wrapRef.current && wrapRef.current.scrollTop > 0) {
      wrapRef.current.scrollTop = 0;
      setScrollTop(0);
    }
  }, [sort, deferredSearch]);

  const widthOf = useCallback(
    (column: number) => widths.get(column) ?? (column === INDEX_COLUMN ? INDEX_WIDTH : DEFAULT_WIDTH),
    [widths]
  );

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop), []);

  const toggleSort = useCallback((column: number) => {
    setSort((current) =>
      current?.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' }
    );
  }, []);

  // ---- column resizing: pointer capture, so there are no document listeners to clean up
  const setWidth = useCallback((column: number, width: number) => {
    setWidths((current) => new Map(current).set(column, Math.max(MIN_WIDTH, Math.round(width))));
  }, []);
  const resize = useMemo<ResizeHandlers>(
    () => ({
      onResizeStart(event) {
        const column = Number(event.currentTarget.dataset.col);
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { column, startX: event.clientX, startWidth: widthOf(column) };
      },
      onResizeMove(event) {
        const active = drag.current;
        if (active) {
          setWidth(active.column, active.startWidth + event.clientX - active.startX);
        }
      },
      onResizeEnd() {
        drag.current = null;
      },
      onResizeKey(event) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const column = Number(event.currentTarget.dataset.col);
          setWidth(column, widthOf(column) + (event.key === 'ArrowRight' ? 16 : -16));
        }
      }
    }),
    [setWidth, widthOf]
  );

  // ---- one delegated click handler instead of a closure per cell
  const onBodyClick = useCallback((event: React.MouseEvent<HTMLTableSectionElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('td[data-r]');
    if (cell) {
      setInspected({ row: Number(cell.dataset.r), column: Number(cell.dataset.c) });
    }
  }, []);

  const total = table.rows.length;
  const windowed = ordered.length > WINDOWING_THRESHOLD;
  const { start, end } = windowed
    ? windowRange({ scrollTop, viewportHeight, rowHeight: ROW_HEIGHT, total: ordered.length })
    : { start: 0, end: ordered.length };
  const visible = ordered.slice(start, end);
  const columnCount = model.columns.length;
  const tableWidth = widthOf(INDEX_COLUMN) + model.columns.reduce((sum, _, c) => sum + widthOf(c), 0);
  const inspectedRow = inspected ? table.rows[inspected.row] : undefined;

  return (
    <div className="rl-table-shell">
      <div className="rl-table-toolbar">
        <input
          className="rl-table-search"
          type="search"
          placeholder="Search table…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search table rows"
        />
        <span className="meta" aria-live="polite">
          {ordered.length === total ? `${total} rows` : `${ordered.length} / ${total} rows`}
          {table.totalRows !== undefined && table.totalRows > total ? ` (of ${table.totalRows})` : ''}
          {table.totalColumns !== undefined && table.totalColumns > columnCount ? ` · ${columnCount}+ columns` : ''}
        </span>
        <button
          type="button"
          className="rl-table-action"
          disabled={ordered.length === 0}
          title={search ? 'Copy the matching rows as TSV' : 'Copy the table as TSV'}
          onClick={() => onCopy(buildTsv(model, ordered), 'table')}
        >
          Copy table
        </button>
      </div>

      <div className="rl-table-wrap" ref={wrapRef} onScroll={onScroll} role="region" aria-label="Console table" tabIndex={0}>
        <table className="rl-table" style={{ width: tableWidth }}>
          <colgroup>
            <col style={{ width: widthOf(INDEX_COLUMN) }} />
            {model.columns.map((_, c) => (
              <col key={c} style={{ width: widthOf(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <Header label={table.indexLabel ?? '(index)'} column={INDEX_COLUMN} sort={sort} onSort={toggleSort} {...resize} />
              {model.columns.map((label, c) => (
                <Header key={c} label={label} column={c} sort={sort} onSort={toggleSort} {...resize} />
              ))}
            </tr>
          </thead>
          <tbody onClick={onBodyClick}>
            {windowed && start > 0 ? <Spacer height={start * ROW_HEIGHT} span={columnCount + 1} /> : null}
            {visible.map((rowIndex) => (
              <Row
                key={rowIndex}
                rowIndex={rowIndex}
                row={table.rows[rowIndex]}
                columnCount={columnCount}
                selectedColumn={inspected?.row === rowIndex ? inspected.column : undefined}
              />
            ))}
            {windowed && end < ordered.length ? (
              <Spacer height={(ordered.length - end) * ROW_HEIGHT} span={columnCount + 1} />
            ) : null}
            {ordered.length === 0 ? (
              <tr>
                <td className="rl-table-empty" colSpan={columnCount + 1}>
                  {total === 0 ? 'Empty table: console.table received no rows.' : `No rows match “${deferredSearch}”.`}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {inspected && inspectedRow ? (
        <Inspector
          title={`row ${inspectedRow.key} · ${model.columns[inspected.column] ?? ''}`}
          text={cellDetail(inspectedRow.cells[inspected.column])}
          onCopy={(text) => onCopy(text, 'cell')}
          onClose={() => setInspected(null)}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ pieces

interface HeaderProps extends ResizeHandlers {
  label: string;
  column: number;
  sort: SortSpec | null;
  onSort: (column: number) => void;
}

const Header = memo(function Header({
  label,
  column,
  sort,
  onSort,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeKey
}: HeaderProps): React.ReactElement {
  const direction = sort?.column === column ? sort.direction : undefined;
  return (
    <th aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}>
      <div className="rl-table-header">
        <button className="rl-table-sort" type="button" title={`Sort by ${label}`} onClick={() => onSort(column)}>
          <span className="rl-table-label">{label}</span>
          <span aria-hidden="true">{direction === 'asc' ? ' ▲' : direction === 'desc' ? ' ▼' : ''}</span>
        </button>
        <span
          className="rl-table-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label} column`}
          tabIndex={0}
          data-col={column}
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
          onLostPointerCapture={onResizeEnd}
          onKeyDown={onResizeKey}
        />
      </div>
    </th>
  );
});

const Spacer = memo(function Spacer({ height, span }: { height: number; span: number }): React.ReactElement {
  return (
    <tr className="rl-spacer" aria-hidden="true" style={{ height }}>
      <td colSpan={span} />
    </tr>
  );
});

interface RowProps {
  rowIndex: number;
  row: ConsoleTableRow;
  columnCount: number;
  selectedColumn: number | undefined;
}

const Row = memo(function Row({ rowIndex, row, columnCount, selectedColumn }: RowProps): React.ReactElement {
  const cells: React.ReactElement[] = [];
  for (let c = 0; c < columnCount; c++) {
    const value = row.cells[c];
    const text = cellText(value);
    cells.push(
      <td
        key={c}
        data-r={rowIndex}
        data-c={c}
        className={`rl-cell rl-cell-${value?.k ?? 'undefined'}${selectedColumn === c ? ' is-selected' : ''}`}
        title={text.length > 40 ? text : undefined}
      >
        {text}
      </td>
    );
  }
  return (
    <tr>
      <td className="rl-table-index" title={row.key.length > 12 ? row.key : undefined}>
        {row.key}
      </td>
      {cells}
    </tr>
  );
});

function Inspector({
  title,
  text,
  onCopy,
  onClose
}: {
  title: string;
  text: string;
  onCopy: (text: string) => void;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="rl-inspector" role="region" aria-label="Cell value">
      <div className="rl-inspector-bar">
        <span className="meta">{title}</span>
        <button type="button" onClick={() => onCopy(text)}>
          Copy
        </button>
        <button type="button" onClick={onClose} aria-label="Close cell value">
          ✕
        </button>
      </div>
      <pre className="value">{text}</pre>
    </div>
  );
}
