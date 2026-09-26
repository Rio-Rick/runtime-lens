import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { SerializedValue } from '../protocol';
import { ConsoleTable, type TableSortDirection } from './components/ConsoleTable';
import './media/style.css';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
};

interface TablePayload {
  columns: string[];
  rows: Array<{ key: string; cells: SerializedValue[] }>;
  truncated?: boolean;
}

interface WireEvent {
  key: number;
  kind: string;
  level?: string;
  text: string;
  detail: string;
  file: string;
  short: string;
  line: number;
  count: number;
  ts: number;
  remapped: boolean;
  table?: TablePayload;
}

interface SnapshotMessage {
  type: 'snapshot';
  events: WireEvent[];
  follow: boolean;
  paused: boolean;
  filter: string;
  stats: {
    size: number;
    capacity: number;
    dropped: number;
    totalAdded: number;
  };
}

const vscode = acquireVsCodeApi();

function App(): React.ReactElement {
  const [events, setEvents] = useState<WireEvent[]>([]);
  const [selectedKey, setSelectedKey] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [stats, setStats] = useState<SnapshotMessage['stats']>({
    size: 0,
    capacity: 0,
    dropped: 0,
    totalAdded: 0
  });
  const [sortKey, setSortKey] = useState('(index)');
  const [sortDirection, setSortDirection] = useState<TableSortDirection>('asc');
  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<string[]>(['log', 'info', 'warn', 'error', 'debug', 'table']);

  const selected = useMemo(
    () => events.find((event) => event.key === selectedKey),
    [events, selectedKey]
  );

  const visibleEvents = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return events.filter((event) => {
      const levelMatches = levels.includes(event.level ?? '');
      const textMatches = needle.length === 0 || `${event.text} ${event.file}`.toLowerCase().includes(needle);
      return levelMatches && textMatches;
    });
  }, [events, levels, query]);

  useEffect(() => {
    const handleMessage = (message: MessageEvent<SnapshotMessage>) => {
      const data = message.data;
      if (!data || data.type !== 'snapshot') {
        return;
      }

      setEvents(data.events ?? []);
      setPaused(Boolean(data.paused));
      setFollow(Boolean(data.follow));
      setStats(data.stats ?? { size: 0, capacity: 0, dropped: 0, totalAdded: 0 });

      setSelectedKey((current) => {
        if (data.events.length === 0) {
          return null;
        }
        return current !== null && data.events.some((event) => event.key === current)
          ? current
          : data.events[0].key;
      });
    };

    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  useEffect(() => {
    if (!follow || visibleEvents.length === 0) {
      return;
    }
    setSelectedKey((current) => current ?? visibleEvents[0].key);
  }, [follow, visibleEvents]);

  const activeSelected = selected ?? visibleEvents[0];

  function toggleSort(column: string): void {
    if (sortKey === column) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortKey(column);
    setSortDirection('asc');
  }

  function setPausedValue(value: boolean): void {
    setPaused(value);
    vscode.postMessage({ type: 'pause', paused: value });
  }

  function setFollowValue(value: boolean): void {
    setFollow(value);
    vscode.postMessage({ type: 'follow', follow: value });
  }

  function clear(): void {
    setSelectedKey(null);
    vscode.postMessage({ type: 'clear' });
  }

  return (
    <div className="rl-shell">
      <header className="toolbar">
        <input
          className="rl-search"
          type="search"
          placeholder="Search values, files…"
          value={query}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            vscode.postMessage({ type: 'filter', query: next, levels: levels.length === 6 ? [] : levels });
          }}
        />

        <div className="levels" aria-label="Console levels">
          {['log', 'info', 'warn', 'error', 'debug', 'table'].map((level) => {
            const checked = levels.includes(level);
            return (
              <label key={level}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    const next = event.target.checked
                      ? [...new Set([...levels, level])]
                      : levels.filter((item) => item !== level);
                    setLevels(next);
                    vscode.postMessage({ type: 'filter', query, levels: next.length === 6 ? [] : next });
                  }}
                />
                {level}
              </label>
            );
          })}
        </div>

        <div className="actions">
          <button type="button" className={paused ? 'on' : ''} onClick={() => setPausedValue(!paused)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className={follow ? 'on' : ''} onClick={() => setFollowValue(!follow)}>
            Follow
          </button>
          <button type="button" onClick={clear}>
            Clear
          </button>
        </div>
      </header>

      <main>
        <section className="list" aria-label="Runtime events">
          {visibleEvents.map((event) => (
            <button
              className={`event-row ${event.key === activeSelected?.key ? 'selected' : ''}`}
              key={event.key}
              type="button"
              onClick={() => setSelectedKey(event.key)}
              onDoubleClick={() => vscode.postMessage({ type: 'reveal', key: event.key })}
            >
              <span className="glyph">
                {event.kind === 'expr' ? '?' : event.kind === 'error' ? '✖' : event.level === 'table' ? '▦' : '›'}
              </span>
              <span className="text">{event.text}</span>
              <span className="meta">
                {event.short}:{event.line}
                {event.count > 1 ? ` ×${event.count}` : ''}
                {event.remapped ? ' ↺' : ''}
              </span>
            </button>
          ))}
        </section>

        <section className="detail" aria-label="Event details">
          {activeSelected ? (
            <>
              <div className="detail-toolbar">
                <button type="button" onClick={() => vscode.postMessage({ type: 'reveal', key: activeSelected.key })}>
                  Go to source
                </button>
                <button type="button" onClick={() => vscode.postMessage({ type: 'copy', key: activeSelected.key })}>
                  Copy value
                </button>
                <span className="meta">
                  {activeSelected.file}:{activeSelected.line} · {new Date(activeSelected.ts).toLocaleTimeString()}
                </span>
              </div>

              {activeSelected.table ? (
                <div className="table-panel">
                  <div className="table-heading">
                    <span>console.table</span>
                    <span className="meta">
                      {activeSelected.table.rows.length} rows · {activeSelected.table.columns.length} columns
                      {activeSelected.table.truncated ? ' · truncated' : ''}
                    </span>
                  </div>
                  <ConsoleTable
                    key={activeSelected.key}
                    columns={activeSelected.table.columns}
                    rows={activeSelected.table.rows}
                    sortKey={sortKey}
                    sortDirection={sortDirection}
                    onSort={toggleSort}
                    onCopyTable={(text) => vscode.postMessage({ type: 'copy-table', text })}
                  />
                </div>
              ) : (
                <pre className="value">{activeSelected.detail}</pre>
              )}
            </>
          ) : (
            <p className="hint">Select an event to inspect its value.</p>
          )}
        </section>
      </main>

      <footer className="status">
        {visibleEvents.length} shown · {stats.size}/{stats.capacity} buffered · {stats.totalAdded} total
        {stats.dropped ? ` · ${stats.dropped} dropped` : ''}
        {paused ? ' · PAUSED' : ''}
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
