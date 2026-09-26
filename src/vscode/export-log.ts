import { PROTOCOL_VERSION, type LogLevel } from '../protocol';
import type { EventFilter, StoredEvent } from '../runtime/store';
import { eventText } from './render';

export interface ExportedEvent {
  key: number;
  kind: 'log' | 'expr' | 'error';
  level?: LogLevel;
  text: string;
  file: string;
  line: number;
  column: number;
  count: number;
  timestamp: string;
  sessionId: string;
  remapped: boolean;
}

export interface ExportFilterSummary {
  query: string;
  levels: LogLevel[];
  file?: string;
}

export interface ExportPayload {
  tool: 'runtime-lens';
  generatedAt: string;
  protocolVersion: string;
  /** Present only when a filter was active, so an unfiltered export omits it entirely. */
  filter?: ExportFilterSummary;
  totalEvents: number;
  events: ExportedEvent[];
}

export interface BuildExportOptions {
  filter?: EventFilter;
  protocolVersion?: string;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => Date;
}

function summarizeFilter(filter: EventFilter | undefined): ExportFilterSummary | undefined {
  if (!filter) {
    return undefined;
  }
  const hasQuery = filter.query.length > 0;
  const hasLevels = filter.levels !== undefined && filter.levels.size > 0;
  const hasFile = filter.file !== undefined && filter.file.length > 0;
  if (!hasQuery && !hasLevels && !hasFile) {
    return undefined;
  }
  return {
    query: filter.query,
    levels: filter.levels ? [...filter.levels] : [],
    file: filter.file
  };
}

/**
 * Turn captured events into a self-describing export payload.
 *
 * `events` is expected in `EventStore.list()`'s newest-first order; the
 * payload reorders them oldest-first, since a saved log reads top-to-bottom
 * like a transcript. Value text is rendered through the same `eventText`
 * helper the tree view and hovers use, capped generously (well past the
 * inline/hover limits) rather than left unbounded, so one runaway object
 * can't blow up the exported file.
 */
export function buildExportPayload(events: readonly StoredEvent[], options: BuildExportOptions = {}): ExportPayload {
  const now = (options.now ?? (() => new Date()))();
  const chronological = [...events].reverse();
  const filter = summarizeFilter(options.filter);
  return {
    tool: 'runtime-lens',
    generatedAt: now.toISOString(),
    protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION,
    // Spread rather than `filter: filter` so an inactive filter leaves the
    // key absent entirely (matching the `filter?:` optional type) instead of
    // present-but-`undefined` — cleaner for anything that does `'filter' in
    // payload` and one less JSON/JS-equality mismatch to trip over.
    ...(filter ? { filter } : {}),
    totalEvents: chronological.length,
    events: chronological.map((stored) => ({
      key: stored.key,
      kind: stored.event.t,
      level: stored.event.t === 'log' ? stored.event.level : undefined,
      text: eventText(stored.event, 20_000, 6),
      file: stored.loc.file,
      line: stored.loc.line,
      column: stored.loc.column,
      count: stored.event.count,
      timestamp: new Date(stored.event.ts).toISOString(),
      sessionId: stored.sessionId,
      remapped: stored.remapped
    }))
  };
}

export function exportPayloadToJson(payload: ExportPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** A filesystem-safe default file name, e.g. `runtime-lens-log-2026-09-22T14-05-00.json`. */
export function defaultExportFileName(now: Date = new Date()): string {
  return `runtime-lens-log-${now.toISOString().replace(/[:.]/g, '-')}.json`;
}
