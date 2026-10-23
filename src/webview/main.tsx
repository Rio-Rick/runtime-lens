import React, { memo, useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConsoleTable } from './components/ConsoleTable';
import { Highlight } from './components/Highlight';
import { DetailValue } from './components/ValueTree';
import { parseHostMessage, type WebviewMessage, type WireEvent } from './messages';
import { createMatcher, type Matcher } from './search-highlight';
import { planDetail, searchDetail } from './tree-model';
import { initialState, reduce, shouldStopFollowing } from './view-state';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
};

// `acquireVsCodeApi` may only be called once per Webview.
const vscode = acquireVsCodeApi();
const post = (message: WebviewMessage): void => vscode.postMessage(message);

const LEVELS = ['log', 'info', 'warn', 'error', 'debug', 'table'] as const;
const KNOWN_HOST_TYPES = new Set(['snapshot', 'detail', 'detail-missing']);
/** Wait for typing to pause before asking the host to re-filter (the host also refreshes the tree). */
const FILTER_DEBOUNCE_MS = 150;

interface EventRowProps {
  event: WireEvent;
  selected: boolean;
  /** Search matches to highlight; stable between renders until the query changes. */
  matcher: Matcher | undefined;
  onSelect: (key: number) => void;
  onReveal: (key: number) => void;
}

/** Memoised: snapshots reuse unchanged event objects, so untouched rows skip rendering. */
const EventRow = memo(function EventRow({ event, selected, matcher, onSelect, onReveal }: EventRowProps): React.ReactElement {
  return (
    <button
      className={`event-row ${selected ? 'selected' : ''}`}
      type="button"
      onClick={() => onSelect(event.key)}
      onDoubleClick={() => onReveal(event.key)}
    >
      <span className="glyph">
        {event.kind === 'expr' ? '?' : event.kind === 'error' ? '✖' : event.table ? '▦' : '›'}
      </span>
      <span className="index" title="Entry number since the last Clear">
        #{event.index}
      </span>
      <span className="text">
        <Highlight text={event.text} matcher={matcher} />
      </span>
      <span className="meta">
        <Highlight text={event.short} matcher={matcher} />:{event.line}
        {event.count > 1 ? ` ×${event.count}` : ''}
        {event.remapped ? ' ↺' : ''}
      </span>
    </button>
  );
});

function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<readonly string[]>(LEVELS);
  const filterTimer = useRef<number | undefined>(undefined);
  /** The last text filter the host is known to have (sent by us, or adopted from it). */
  const hostFilter = useRef('');
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });

  // One listener for the life of the Webview, removed on unmount.
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const message = parseHostMessage(event.data);
      if (!message) {
        const type = (event.data as { type?: unknown } | null)?.type;
        if (typeof type === 'string' && KNOWN_HOST_TYPES.has(type)) {
          console.error('Runtime Lens: ignored malformed host message', type);
        }
        return;
      }
      switch (message.type) {
        case 'snapshot':
          dispatch({ type: 'snapshot', message });
          break;
        case 'detail':
          dispatch({ type: 'detail', message });
          break;
        case 'detail-missing':
          dispatch({ type: 'detail-missing', key: message.key });
          break;
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => () => window.clearTimeout(filterTimer.current), []);

  // Adopt a filter that was changed on the host side (e.g. the command palette),
  // but never echo back what we sent ourselves: that would fight the user's typing.
  useEffect(() => {
    if (state.filter !== hostFilter.current) {
      hostFilter.current = state.filter;
      setQuery(state.filter);
    }
  }, [state.filter]);

  const sendFilter = useCallback((nextQuery: string, nextLevels: readonly string[]) => {
    hostFilter.current = nextQuery;
    post({ type: 'filter', query: nextQuery, levels: nextLevels.length === LEVELS.length ? [] : [...nextLevels] });
  }, []);

  // Ask the host for the selected event's heavy payload (table rows / full text) once.
  const { selectedKey } = state;
  const hasDetail = selectedKey !== null && state.details.has(selectedKey);
  const isMissing = selectedKey !== null && state.missing.has(selectedKey);
  useEffect(() => {
    if (selectedKey !== null && !hasDetail && !isMissing) {
      post({ type: 'select', key: selectedKey });
    }
  }, [selectedKey, hasDetail, isMissing]);

  const select = useCallback((key: number) => {
    if (shouldStopFollowing(latest.current, key)) {
      post({ type: 'follow', follow: false });
    }
    dispatch({ type: 'select', key });
  }, []);
  const reveal = useCallback((key: number) => post({ type: 'reveal', key }), []);
  const copyText = useCallback((text: string, label: string) => post({ type: 'copy-text', text, label }), []);

  // While the newly selected event's detail is in flight, keep showing the last
  // one instead of blanking the pane (with Follow on, that would flicker).
  const detail =
    selectedKey !== null
      ? state.details.get(selectedKey) ?? [...state.details.values()].pop()
      : undefined;
  const shown = detail ? state.events.find((event) => event.key === detail.key) : undefined;
  const { stats } = state;

  // Highlight what the host actually filtered by (`state.filter`), not the keystroke in
  // flight: the highlights then always describe the list on screen, and rows re-render
  // once per debounce instead of once per key. An emptied box clears them at once.
  const activeQuery = query === '' ? '' : state.filter;
  const matcher = useMemo(() => createMatcher(activeQuery), [activeQuery]);

  // The inspect pane's own search: local to the selected value, never sent to the host and
  // never touching the list. While it is in use it replaces the list-search highlight there.
  const [detailQuery, setDetailQuery] = useState('');
  const deferredDetailQuery = useDeferredValue(detailQuery);
  const detailMatcher = useMemo(() => createMatcher(deferredDetailQuery), [deferredDetailQuery]);
  const valueDetail = detail && !detail.table ? detail : undefined;
  const blocks = useMemo(() => (valueDetail ? planDetail(valueDetail) : undefined), [valueDetail]);
  const found = useMemo(
    () => (valueDetail && detailMatcher ? searchDetail(valueDetail.detail, blocks, detailMatcher) : undefined),
    [valueDetail, blocks, detailMatcher]
  );

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
            window.clearTimeout(filterTimer.current);
            if (next === '') {
              // Clearing restores the full list right away instead of waiting out the debounce.
              sendFilter(next, levels);
            } else {
              filterTimer.current = window.setTimeout(() => sendFilter(next, levels), FILTER_DEBOUNCE_MS);
            }
          }}
        />

        <div className="levels" aria-label="Console levels">
          {LEVELS.map((level) => (
            <label key={level}>
              <input
                type="checkbox"
                checked={levels.includes(level)}
                onChange={(event) => {
                  const next = event.target.checked ? LEVELS.filter((l) => l === level || levels.includes(l)) : levels.filter((l) => l !== level);
                  setLevels(next);
                  window.clearTimeout(filterTimer.current);
                  sendFilter(query, next);
                }}
              />
              {level}
            </label>
          ))}
        </div>

        <div className="actions">
          <button
            type="button"
            className={state.paused ? 'on' : ''}
            onClick={() => {
              dispatch({ type: 'set-paused', value: !state.paused });
              post({ type: 'pause', paused: !state.paused });
            }}
          >
            {state.paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className={state.follow ? 'on' : ''}
            title="Keep the newest entry selected"
            onClick={() => {
              dispatch({ type: 'set-follow', value: !state.follow });
              post({ type: 'follow', follow: !state.follow });
            }}
          >
            Follow
          </button>
          <button type="button" onClick={() => post({ type: 'clear' })}>
            Clear
          </button>
        </div>
      </header>

      {state.scope ? (
        <div className="scope-bar" role="status">
          <span>
            Every retained run of <code>{state.scope}</code> · {state.events.length} shown. Select one to see its full value.
          </span>
          <button type="button" onClick={() => post({ type: 'clear-scope' })}>
            Show all
          </button>
        </div>
      ) : null}

      <main>
        <section className="list" aria-label="Runtime events">
          {state.events.length === 0 ? (
            <p className="hint">No entries yet. Run a process with Runtime Lens attached.</p>
          ) : null}
          {state.events.map((event) => (
            <EventRow
              key={event.key}
              event={event}
              selected={event.key === selectedKey}
              matcher={matcher}
              onSelect={select}
              onReveal={reveal}
            />
          ))}
        </section>

        <section className="detail" aria-label="Event details">
          {shown && detail ? (
            <>
              <div className="detail-toolbar">
                <button type="button" onClick={() => post({ type: 'reveal', key: shown.key })}>
                  Go to source
                </button>
                <button type="button" onClick={() => post({ type: 'copy', key: shown.key })}>
                  Copy value
                </button>
                {!detail.table ? (
                  <>
                    <input
                      className="rl-detail-search"
                      type="search"
                      placeholder="Search in value…"
                      aria-label="Search in this value"
                      value={detailQuery}
                      onChange={(event) => setDetailQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          setDetailQuery('');
                        }
                      }}
                    />
                    {detailQuery !== '' && found ? (
                      <span className="meta" role="status">
                        {found.count === 0
                          ? 'No matches'
                          : `${found.count}${found.complete ? '' : '+'} match${found.count === 1 ? '' : 'es'}`}
                      </span>
                    ) : null}
                  </>
                ) : null}
                <span className="meta">
                  #{shown.index} · {shown.file}:{shown.line} · {new Date(shown.ts).toLocaleTimeString()}
                </span>
              </div>

              {detail.table ? (
                <div className="table-panel">
                  <div className="table-heading">
                    <span>console.table</span>
                    <span className="meta">
                      {detail.table.rows.length} rows · {detail.table.columns.length} columns
                      {detail.table.truncated ? ' · truncated' : ''}
                    </span>
                  </div>
                  <ConsoleTable key={detail.key} table={detail.table} onCopy={copyText} />
                </div>
              ) : (
                <DetailValue key={detail.key} detail={detail} blocks={blocks} matcher={detailMatcher ?? matcher} search={found} />
              )}
            </>
          ) : selectedKey !== null && isMissing ? (
            <p className="hint">This entry is no longer available.</p>
          ) : (
            <p className="hint">{state.events.length === 0 ? 'Nothing to inspect yet.' : 'Select an event to inspect its value.'}</p>
          )}
        </section>
      </main>

      <footer className="status">
        {state.events.length} shown · {stats.size}/{stats.capacity} buffered · {stats.totalAdded} total
        {stats.dropped ? ` · ${stats.dropped} dropped` : ''}
        {state.paused ? ' · PAUSED' : ''}
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
