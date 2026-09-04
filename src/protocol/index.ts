/**
 * Runtime Lens wire protocol.
 *
 * The protocol is intentionally tiny, versioned and validated on both ends.
 * The instrumented process (the "agent") is the *client*; the extension host
 * runs the server. Every message carries the protocol version so that an old
 * agent baked into a long-running dev server can be rejected with a clear
 * error instead of silently producing garbage.
 */

export const PROTOCOL_VERSION = '1.0.0';

/** Bump when the shape of an existing message changes incompatibly. */
export const PROTOCOL_MAJOR = 1;

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'table';

export const LOG_LEVELS: readonly LogLevel[] = ['log', 'info', 'warn', 'error', 'debug', 'table'];

export type RuntimeKind = 'node' | 'browser' | 'edge' | 'unknown';

/** A serialized value. Discriminated on `k` (kind). */
export type SerializedValue =
  | { k: 'string'; v: string; truncated?: boolean; length?: number }
  | { k: 'number'; v: number | 'NaN' | 'Infinity' | '-Infinity' }
  | { k: 'boolean'; v: boolean }
  | { k: 'null' }
  | { k: 'undefined' }
  | { k: 'bigint'; v: string }
  | { k: 'symbol'; v: string }
  | { k: 'date'; v: string }
  | { k: 'regexp'; v: string }
  | { k: 'function'; name: string; kind: 'function' | 'class' | 'arrow'; arity: number }
  | { k: 'error'; name: string; message: string; stack?: string; props?: Record<string, SerializedValue> }
  | { k: 'array'; entries: SerializedValue[]; length: number; truncated?: boolean }
  | { k: 'object'; ctor?: string; entries: Array<[string, SerializedValue]>; size: number; truncated?: boolean }
  | { k: 'map'; entries: Array<[SerializedValue, SerializedValue]>; size: number; truncated?: boolean }
  | { k: 'set'; entries: SerializedValue[]; size: number; truncated?: boolean }
  | { k: 'circular'; path: string }
  | { k: 'maxdepth'; hint: string }
  | { k: 'unserializable'; hint: string };

/** Where a probe lives in the *original* source file. */
export interface SourceLocation {
  /** Absolute path of the original file as known at instrumentation time. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface BaseEvent {
  /** Stable, content-derived probe id (see utils/probe-id). */
  id: string;
  /** Monotonic per-session sequence number. */
  seq: number;
  /** ms since epoch, taken in the instrumented process. */
  ts: number;
  loc: SourceLocation;
  /** Number of times this probe has executed in the current process. */
  count: number;
}

export interface LogEvent extends BaseEvent {
  t: 'log';
  level: LogLevel;
  args: SerializedValue[];
  /** Raw expression text of each argument, as written in source. */
  exprs?: string[];
}

export interface ExprEvent extends BaseEvent {
  t: 'expr';
  /** Source text of the probed expression, e.g. `user.name`. */
  expr: string;
  value: SerializedValue;
}

export interface ErrorEvent extends BaseEvent {
  t: 'error';
  message: string;
  stack?: string;
  fatal: boolean;
}

export type RuntimeEvent = LogEvent | ExprEvent | ErrorEvent;

export interface HelloMessage {
  t: 'hello';
  v: string;
  token: string;
  sessionId: string;
  runtime: RuntimeKind;
  /** Free-form label shown in the UI, e.g. "next-dev (pid 4211)". */
  label: string;
  pid?: number;
  cwd?: string;
}

export interface BatchMessage {
  t: 'batch';
  v: string;
  sessionId: string;
  events: RuntimeEvent[];
  /** Events dropped by the agent's bounded buffer since the last batch. */
  dropped?: number;
}

export interface ByeMessage {
  t: 'bye';
  v: string;
  sessionId: string;
  reason?: string;
}

export type ClientMessage = HelloMessage | BatchMessage | ByeMessage;

export interface ServerAckMessage {
  t: 'ack';
  v: string;
  received: number;
}

export interface ServerConfigMessage {
  t: 'config';
  v: string;
  /** Agent-side capture switches, pushed live from extension settings. */
  captureConsole: boolean;
  captureExpressions: boolean;
  paused: boolean;
  objectDepth: number;
}

export interface ServerErrorMessage {
  t: 'error';
  v: string;
  code: 'bad-version' | 'bad-token' | 'bad-message' | 'too-large' | 'internal';
  message: string;
}

export type ServerMessage = ServerAckMessage | ServerConfigMessage | ServerErrorMessage;

/** Hard cap on a single batch regardless of user settings. */
export const ABSOLUTE_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_EVENTS_PER_BATCH = 500;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: ServerErrorMessage['code']; error: string };

function fail<T>(code: ServerErrorMessage['code'], error: string): ValidationResult<T> {
  return { ok: false, code, error };
}

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function isCompatibleVersion(v: unknown): boolean {
  if (typeof v !== 'string') {
    return false;
  }
  const major = Number.parseInt(v.split('.')[0] ?? '', 10);
  return Number.isInteger(major) && major === PROTOCOL_MAJOR;
}

function validateLocation(x: unknown): ValidationResult<SourceLocation> {
  if (!isPlainRecord(x)) {
    return fail('bad-message', 'loc must be an object');
  }
  const { file, line, column } = x;
  if (typeof file !== 'string' || file.length === 0 || file.length > 4096) {
    return fail('bad-message', 'loc.file must be a non-empty string');
  }
  if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) {
    return fail('bad-message', 'loc.line must be a positive number');
  }
  if (typeof column !== 'number' || !Number.isFinite(column) || column < 0) {
    return fail('bad-message', 'loc.column must be a non-negative number');
  }
  const loc: SourceLocation = { file, line: Math.floor(line), column: Math.floor(column) };
  if (typeof x.endLine === 'number' && Number.isFinite(x.endLine)) {
    loc.endLine = Math.floor(x.endLine);
  }
  if (typeof x.endColumn === 'number' && Number.isFinite(x.endColumn)) {
    loc.endColumn = Math.floor(x.endColumn);
  }
  return { ok: true, value: loc };
}

/**
 * Structural validation of a serialized value. We deliberately do *not* try to
 * deep-clone or normalize: we only assert that `k` is a kind we can render, so
 * a malicious or buggy client cannot inject arbitrary shapes into the UI.
 */
export function validateSerializedValue(x: unknown, depth = 0): boolean {
  if (depth > 32 || !isPlainRecord(x) || typeof x.k !== 'string') {
    return false;
  }
  switch (x.k) {
    case 'null':
    case 'undefined':
      return true;
    case 'string':
      return typeof x.v === 'string';
    case 'number':
      return typeof x.v === 'number' || x.v === 'NaN' || x.v === 'Infinity' || x.v === '-Infinity';
    case 'boolean':
      return typeof x.v === 'boolean';
    case 'bigint':
    case 'symbol':
    case 'date':
    case 'regexp':
      return typeof x.v === 'string';
    case 'function':
      return typeof x.name === 'string' && typeof x.arity === 'number';
    case 'error':
      return typeof x.name === 'string' && typeof x.message === 'string';
    case 'array':
    case 'set':
      return Array.isArray(x.entries) && x.entries.every((e) => validateSerializedValue(e, depth + 1));
    case 'object':
      return (
        Array.isArray(x.entries) &&
        x.entries.every(
          (e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && validateSerializedValue(e[1], depth + 1)
        )
      );
    case 'map':
      return (
        Array.isArray(x.entries) &&
        x.entries.every(
          (e) =>
            Array.isArray(e) &&
            e.length === 2 &&
            validateSerializedValue(e[0], depth + 1) &&
            validateSerializedValue(e[1], depth + 1)
        )
      );
    case 'circular':
      return typeof x.path === 'string';
    case 'maxdepth':
    case 'unserializable':
      return typeof x.hint === 'string';
    default:
      return false;
  }
}

function validateEvent(x: unknown): ValidationResult<RuntimeEvent> {
  if (!isPlainRecord(x)) {
    return fail('bad-message', 'event must be an object');
  }
  if (typeof x.id !== 'string' || x.id.length === 0 || x.id.length > 128) {
    return fail('bad-message', 'event.id must be a short string');
  }
  if (typeof x.seq !== 'number' || !Number.isFinite(x.seq) || x.seq < 0) {
    return fail('bad-message', 'event.seq must be a non-negative number');
  }
  if (typeof x.ts !== 'number' || !Number.isFinite(x.ts)) {
    return fail('bad-message', 'event.ts must be a number');
  }
  if (typeof x.count !== 'number' || !Number.isFinite(x.count) || x.count < 1) {
    return fail('bad-message', 'event.count must be >= 1');
  }
  const loc = validateLocation(x.loc);
  if (!loc.ok) {
    return loc as ValidationResult<RuntimeEvent>;
  }
  const base: BaseEvent = { id: x.id, seq: Math.floor(x.seq), ts: x.ts, count: Math.floor(x.count), loc: loc.value };

  switch (x.t) {
    case 'log': {
      if (typeof x.level !== 'string' || !LOG_LEVELS.includes(x.level as LogLevel)) {
        return fail('bad-message', `unknown log level: ${String(x.level)}`);
      }
      if (!Array.isArray(x.args) || x.args.length > 64 || !x.args.every((a) => validateSerializedValue(a))) {
        return fail('bad-message', 'log.args must be an array of serialized values');
      }
      const ev: LogEvent = { ...base, t: 'log', level: x.level as LogLevel, args: x.args as SerializedValue[] };
      if (Array.isArray(x.exprs) && x.exprs.every((e) => typeof e === 'string')) {
        ev.exprs = x.exprs as string[];
      }
      return { ok: true, value: ev };
    }
    case 'expr': {
      if (typeof x.expr !== 'string' || x.expr.length > 4096) {
        return fail('bad-message', 'expr.expr must be a string');
      }
      if (!validateSerializedValue(x.value)) {
        return fail('bad-message', 'expr.value must be a serialized value');
      }
      return { ok: true, value: { ...base, t: 'expr', expr: x.expr, value: x.value as SerializedValue } };
    }
    case 'error': {
      if (typeof x.message !== 'string') {
        return fail('bad-message', 'error.message must be a string');
      }
      return {
        ok: true,
        value: {
          ...base,
          t: 'error',
          message: x.message.slice(0, 8192),
          stack: typeof x.stack === 'string' ? x.stack.slice(0, 16384) : undefined,
          fatal: x.fatal === true
        }
      };
    }
    default:
      return fail('bad-message', `unknown event type: ${String(x.t)}`);
  }
}

/**
 * Validate a raw (already JSON-parsed) client message.
 * `expectedToken` is checked for `hello` messages only; the transport is
 * responsible for binding subsequent messages to an authenticated socket.
 */
export function validateClientMessage(raw: unknown, expectedToken?: string): ValidationResult<ClientMessage> {
  if (!isPlainRecord(raw)) {
    return fail('bad-message', 'message must be a JSON object');
  }
  if (!isCompatibleVersion(raw.v)) {
    return fail('bad-version', `incompatible protocol version ${String(raw.v)}, server speaks ${PROTOCOL_VERSION}`);
  }
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0 || raw.sessionId.length > 64) {
    return fail('bad-message', 'sessionId must be a short non-empty string');
  }
  switch (raw.t) {
    case 'hello': {
      if (typeof raw.token !== 'string' || raw.token.length === 0) {
        return fail('bad-token', 'missing token');
      }
      if (expectedToken !== undefined && raw.token !== expectedToken) {
        return fail('bad-token', 'token mismatch');
      }
      const runtime: RuntimeKind =
        raw.runtime === 'node' || raw.runtime === 'browser' || raw.runtime === 'edge' ? raw.runtime : 'unknown';
      return {
        ok: true,
        value: {
          t: 'hello',
          v: raw.v as string,
          token: raw.token,
          sessionId: raw.sessionId,
          runtime,
          label: typeof raw.label === 'string' ? raw.label.slice(0, 200) : 'unknown',
          pid: typeof raw.pid === 'number' ? raw.pid : undefined,
          cwd: typeof raw.cwd === 'string' ? raw.cwd.slice(0, 4096) : undefined
        }
      };
    }
    case 'batch': {
      if (!Array.isArray(raw.events)) {
        return fail('bad-message', 'batch.events must be an array');
      }
      if (raw.events.length > MAX_EVENTS_PER_BATCH) {
        return fail('too-large', `batch has ${raw.events.length} events, max is ${MAX_EVENTS_PER_BATCH}`);
      }
      const events: RuntimeEvent[] = [];
      for (const candidate of raw.events) {
        const res = validateEvent(candidate);
        if (!res.ok) {
          return res as ValidationResult<ClientMessage>;
        }
        events.push(res.value);
      }
      return {
        ok: true,
        value: {
          t: 'batch',
          v: raw.v as string,
          sessionId: raw.sessionId,
          events,
          dropped: typeof raw.dropped === 'number' && raw.dropped > 0 ? Math.floor(raw.dropped) : undefined
        }
      };
    }
    case 'bye':
      return {
        ok: true,
        value: {
          t: 'bye',
          v: raw.v as string,
          sessionId: raw.sessionId,
          reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : undefined
        }
      };
    default:
      return fail('bad-message', `unknown message type: ${String(raw.t)}`);
  }
}

export function parseClientMessage(
  data: string | Uint8Array,
  maxBytes: number,
  expectedToken?: string
): ValidationResult<ClientMessage> {
  const byteLength = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
  const limit = Math.min(maxBytes, ABSOLUTE_MAX_PAYLOAD_BYTES);
  if (byteLength > limit) {
    return fail('too-large', `payload of ${byteLength} bytes exceeds limit of ${limit} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
  } catch (err) {
    return fail('bad-message', `invalid JSON: ${(err as Error).message}`);
  }
  return validateClientMessage(parsed, expectedToken);
}

/**
 * Validate a raw (already JSON-parsed) message sent from the extension host
 * down to an agent. The agent is the *client* on this connection, so there is
 * no token to check here — the socket itself is already authenticated.
 */
export function validateServerMessage(raw: unknown): ValidationResult<ServerMessage> {
  if (!isPlainRecord(raw)) {
    return fail('bad-message', 'message must be a JSON object');
  }
  if (!isCompatibleVersion(raw.v)) {
    return fail('bad-version', `incompatible protocol version ${String(raw.v)}, agent speaks ${PROTOCOL_VERSION}`);
  }
  switch (raw.t) {
    case 'config': {
      if (typeof raw.captureConsole !== 'boolean') {
        return fail('bad-message', 'config.captureConsole must be a boolean');
      }
      if (typeof raw.captureExpressions !== 'boolean') {
        return fail('bad-message', 'config.captureExpressions must be a boolean');
      }
      if (typeof raw.paused !== 'boolean') {
        return fail('bad-message', 'config.paused must be a boolean');
      }
      if (typeof raw.objectDepth !== 'number' || !Number.isFinite(raw.objectDepth) || raw.objectDepth < 0) {
        return fail('bad-message', 'config.objectDepth must be a non-negative number');
      }
      return {
        ok: true,
        value: {
          t: 'config',
          v: raw.v as string,
          captureConsole: raw.captureConsole,
          captureExpressions: raw.captureExpressions,
          paused: raw.paused,
          objectDepth: Math.floor(raw.objectDepth)
        }
      };
    }
    case 'ack':
      return {
        ok: true,
        value: { t: 'ack', v: raw.v as string, received: typeof raw.received === 'number' ? raw.received : 0 }
      };
    case 'error':
      return {
        ok: true,
        value: {
          t: 'error',
          v: raw.v as string,
          code: (['bad-version', 'bad-token', 'bad-message', 'too-large', 'internal'] as const).includes(
            raw.code as ServerErrorMessage['code']
          )
            ? (raw.code as ServerErrorMessage['code'])
            : 'internal',
          message: typeof raw.message === 'string' ? raw.message.slice(0, 2000) : ''
        }
      };
    default:
      return fail('bad-message', `unknown message type: ${String(raw.t)}`);
  }
}

/** Parse + validate a raw message received by an agent from the extension host. */
export function parseServerMessage(data: string): ValidationResult<ServerMessage> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (err) {
    return fail('bad-message', `invalid JSON: ${(err as Error).message}`);
  }
  return validateServerMessage(parsed);
}
