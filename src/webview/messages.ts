import type { ConsoleTablePayload } from '../protocol';

/**
 * The message contract between the extension host (`panel.ts`) and the
 * Webview (`main.tsx`). It lives in one file that both sides import, so the
 * two can't disagree about a payload shape, and both directions validate what
 * they receive instead of trusting it.
 *
 * Type-only imports keep this module free of Node/VS Code dependencies, so it
 * bundles into the Webview and unit-tests under plain Node.
 */

// ------------------------------------------------------------ host -> webview

/** Summary of a table, enough for the list; the rows travel in `DetailMessage`. */
export interface WireTableInfo {
  rows: number;
  columns: number;
  truncated?: boolean;
  totalRows?: number;
  totalColumns?: number;
  indexLabel?: string;
}

/** One row of the event list. Deliberately small: it is re-sent on every snapshot. */
export interface WireEvent {
  /** Stable internal id (never reused, even after Clear). Use for identity. */
  key: number;
  /** Display ordinal since the last Clear. Use for showing "#N". */
  index: number;
  kind: 'log' | 'expr' | 'error';
  level?: string;
  text: string;
  file: string;
  short: string;
  line: number;
  count: number;
  ts: number;
  remapped: boolean;
  table?: WireTableInfo;
}

export interface WireStats {
  size: number;
  capacity: number;
  dropped: number;
  totalAdded: number;
}

export interface SnapshotMessage {
  type: 'snapshot';
  /** Newest first. */
  events: WireEvent[];
  follow: boolean;
  paused: boolean;
  /** The host's current text filter (it is shared with the tree view). */
  filter: string;
  stats: WireStats;
}

/** The heavy part of one event, sent only when it is selected. */
export interface DetailMessage {
  type: 'detail';
  key: number;
  detail: string;
  table?: ConsoleTablePayload;
}

/** The requested event is no longer in the host's history. */
export interface DetailMissingMessage {
  type: 'detail-missing';
  key: number;
}

export type HostMessage = SnapshotMessage | DetailMessage | DetailMissingMessage;

// ------------------------------------------------------------ webview -> host

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'filter'; query: string; levels: string[] }
  | { type: 'clear' }
  | { type: 'pause'; paused: boolean }
  | { type: 'follow'; follow: boolean }
  | { type: 'select'; key: number }
  | { type: 'reveal'; key: number }
  | { type: 'copy'; key: number }
  | { type: 'copy-text'; text: string; label: string };

// ----------------------------------------------------------------- validation

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isString = (value: unknown): value is string => typeof value === 'string';

function isWireEvent(value: unknown): value is WireEvent {
  return (
    isRecord(value) &&
    isInt(value.key) &&
    isInt(value.index) &&
    (value.kind === 'log' || value.kind === 'expr' || value.kind === 'error') &&
    (value.level === undefined || isString(value.level)) &&
    isString(value.text) &&
    isString(value.file) &&
    isString(value.short) &&
    isInt(value.line) &&
    isInt(value.count) &&
    typeof value.ts === 'number' &&
    typeof value.remapped === 'boolean' &&
    (value.table === undefined || (isRecord(value.table) && isInt(value.table.rows) && isInt(value.table.columns)))
  );
}

function isStats(value: unknown): value is WireStats {
  return (
    isRecord(value) &&
    isInt(value.size) &&
    isInt(value.capacity) &&
    isInt(value.dropped) &&
    isInt(value.totalAdded)
  );
}

/** Validate a message the Webview received. `undefined` means "malformed". */
export function parseHostMessage(raw: unknown): HostMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  switch (raw.type) {
    case 'snapshot':
      return Array.isArray(raw.events) &&
        raw.events.every(isWireEvent) &&
        typeof raw.follow === 'boolean' &&
        typeof raw.paused === 'boolean' &&
        isString(raw.filter) &&
        isStats(raw.stats)
        ? (raw as unknown as SnapshotMessage)
        : undefined;
    case 'detail':
      return isInt(raw.key) &&
        isString(raw.detail) &&
        (raw.table === undefined ||
          (isRecord(raw.table) && Array.isArray(raw.table.columns) && Array.isArray(raw.table.rows)))
        ? (raw as unknown as DetailMessage)
        : undefined;
    case 'detail-missing':
      return isInt(raw.key) ? { type: 'detail-missing', key: raw.key } : undefined;
    default:
      return undefined;
  }
}

/** Validate a message the extension host received from the Webview. */
export function parseWebviewMessage(raw: unknown): WebviewMessage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  switch (raw.type) {
    case 'ready':
    case 'clear':
      return { type: raw.type };
    case 'filter':
      return isString(raw.query) && Array.isArray(raw.levels) && raw.levels.every(isString)
        ? { type: 'filter', query: raw.query.slice(0, 1000), levels: raw.levels }
        : undefined;
    case 'pause':
      return typeof raw.paused === 'boolean' ? { type: 'pause', paused: raw.paused } : undefined;
    case 'follow':
      return typeof raw.follow === 'boolean' ? { type: 'follow', follow: raw.follow } : undefined;
    case 'select':
    case 'reveal':
    case 'copy':
      return isInt(raw.key) ? { type: raw.type, key: raw.key } : undefined;
    case 'copy-text':
      return isString(raw.text) && raw.text.length > 0 && isString(raw.label)
        ? { type: 'copy-text', text: raw.text, label: raw.label.slice(0, 40) }
        : undefined;
    default:
      return undefined;
  }
}
