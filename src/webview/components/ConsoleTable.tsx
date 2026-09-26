import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ConsoleTableRow, SerializedValue } from '../../protocol';
import { preview } from '../../serialization/preview';

export type TableSortDirection = 'asc' | 'desc';

export interface ConsoleTableProps {
  columns: string[];
  rows: ConsoleTableRow[];
  sortKey: string;
  sortDirection: TableSortDirection;
  onSort: (column: string) => void;
  onCopyTable?: (text: string) => void;
}

function compareValues(left: SerializedValue | undefined, right: SerializedValue | undefined): number {
  if (left?.k === 'number' && right?.k === 'number' && typeof left.v === 'number' && typeof right.v === 'number') {
    return left.v - right.v;
  }

  const a = preview(left ?? { k: 'undefined' }, { maxLength: 1_000, depth: 2 });
  const b = preview(right ?? { k: 'undefined' }, { maxLength: 1_000, depth: 2 });
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function sortRows(rows: ConsoleTableRow[], columns: string[], sortKey: string, direction: TableSortDirection): ConsoleTableRow[] {
  const columnIndex = columns.indexOf(sortKey);
  if (columnIndex < 0 && sortKey !== '(index)') {
    return rows;
  }

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const comparison =
        sortKey === '(index)'
          ? a.row.key.localeCompare(b.row.key, undefined, { numeric: true, sensitivity: 'base' })
          : compareValues(a.row.cells[columnIndex], b.row.cells[columnIndex]);

      if (comparison !== 0) {
        return direction === 'asc' ? comparison : -comparison;
      }
      return a.index - b.index;
    })
    .map(({ row }) => row);
}

function cellText(value: SerializedValue | undefined): string {
  return preview(value ?? { k: 'undefined' }, {
    maxLength: 500,
    depth: 3,
    quoteStrings: false
  });
}

function tableCellText(value: SerializedValue | undefined): string {
  return cellText(value).replace(/[\t\r\n]+/g, ' ');
}

function buildTsv(columns: string[], rows: ConsoleTableRow[]): string {
  const lines = [
    ['(index)', ...columns].map((value) => tableCellText({ k: 'string', v: value })).join('\t')
  ];

  for (const row of rows) {
    lines.push([
      row.key,
      ...columns.map((_, index) => tableCellText(row.cells[index]))
    ].join('\t'));
  }

  return lines.join('\n');
}

export function ConsoleTable({
  columns,
  rows,
  sortKey,
  sortDirection,
  onSort,
  onCopyTable
}: ConsoleTableProps): React.ReactElement {
  const [search, setSearch] = useState('');
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const resizeRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);

  const sortedRows = useMemo(
    () => sortRows(rows, columns, sortKey, sortDirection),
    [columns, rows, sortKey, sortDirection]
  );

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) {
      return sortedRows;
    }

    return sortedRows.filter((row) => {
      if (row.key.toLowerCase().includes(needle)) {
        return true;
      }
      for (const cell of row.cells) {
        if (cellText(cell).toLowerCase().includes(needle)) {
          return true;
        }
      }
      return false;
    });
  }, [search, sortedRows]);

  useEffect(() => {
    if (!resizeRef.current) {
      return undefined;
    }

    const onMouseMove = (event: MouseEvent): void => {
      const active = resizeRef.current;
      if (!active) {
        return;
      }

      const nextWidth = Math.max(80, active.startWidth + event.clientX - active.startX);
      setColumnWidths((current) => ({ ...current, [active.key]: nextWidth }));
    };

    const onMouseUp = (): void => {
      resizeRef.current = null;
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  function startResize(key: string, event: React.MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget.parentElement;
    const width = target?.getBoundingClientRect().width ?? 120;
    resizeRef.current = { key, startX: event.clientX, startWidth: width };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  function copyTable(): void {
    onCopyTable?.(buildTsv(columns, filteredRows));
  }

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
        <span className="meta">
          {filteredRows.length === sortedRows.length
            ? `${sortedRows.length} rows`
            : `${filteredRows.length} / ${sortedRows.length} rows`}
        </span>
        <button
          type="button"
          className="rl-table-action"
          onClick={copyTable}
          disabled={filteredRows.length === 0}
          title={search ? 'Copy filtered rows as TSV' : 'Copy table as TSV'}
        >
          Copy table
        </button>
      </div>

      <div className="rl-table-wrap" role="region" aria-label="Console table" tabIndex={0}>
        <table className="rl-table">
          <colgroup>
            <col style={{ width: `${columnWidths['(index)'] ?? 96}px` }} />
            {columns.map((column) => (
              <col key={column} style={{ width: `${columnWidths[column] ?? 160}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <TableHeader
                label="(index)"
                sortKey="(index)"
                active={sortKey === '(index)'}
                direction={sortDirection}
                onSort={onSort}
                onResize={startResize}
              />
              {columns.map((column) => (
                <TableHeader
                  key={column}
                  label={column}
                  sortKey={column}
                  active={sortKey === column}
                  direction={sortDirection}
                  onSort={onSort}
                  onResize={startResize}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length > 0 ? (
              filteredRows.map((row) => (
                <tr key={row.key}>
                  <td className="rl-table-index">{row.key}</td>
                  {columns.map((column, index) => (
                    <td key={`${column}:${row.key}:${index}`} title={cellText(row.cells[index])}>
                      {cellText(row.cells[index])}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td className="rl-table-empty" colSpan={columns.length + 1}>
                  No rows match “{search}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface TableHeaderProps {
  label: string;
  sortKey: string;
  active: boolean;
  direction: TableSortDirection;
  onSort: (column: string) => void;
  onResize: (column: string, event: React.MouseEvent<HTMLButtonElement>) => void;
}

function TableHeader({ label, sortKey, active, direction, onSort, onResize }: TableHeaderProps): React.ReactElement {
  const marker = active ? (direction === 'asc' ? ' ▲' : ' ▼') : '';

  return (
    <th aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <div className="rl-table-header">
        <button
          className="rl-table-sort"
          type="button"
          title={`Sort by ${label}`}
          onClick={() => onSort(sortKey)}
        >
          <span>{label}</span>
          <span aria-hidden="true">{marker}</span>
        </button>
        <button
          className="rl-table-resize"
          type="button"
          aria-label={`Resize ${label} column`}
          title={`Resize ${label} column`}
          onMouseDown={(event) => onResize(sortKey, event)}
        />
      </div>
    </th>
  );
}
