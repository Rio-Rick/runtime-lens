/**
 * The in-process agent. This code runs inside the *user's* program (Node
 * process, browser bundle, edge runtime), so it must obey three rules:
 *
 *  1. Never change observable behaviour. `console.log` still logs, probed
 *     expressions still evaluate to themselves, exceptions still propagate.
 *  2. Never block. All I/O is fire-and-forget with a bounded buffer; if the
 *     editor is gone, the buffer drops the oldest events and the program keeps
 *     running at full speed.
 *  3. Never crash the host. Every callback is wrapped; a failure disables the
 *     agent instead of taking the app down.
 */
import { PROTOCOL_VERSION, parseServerMessage, type BatchMessage, type HelloMessage, type LogLevel, type RuntimeEvent, type RuntimeKind } from '../protocol';
import { serialize } from '../serialization/serializer';
import { utf8ByteLength } from '../utils/bytes';
import { isTableSource, normalizeConsoleTable } from './console-table';

export interface AgentTransport {
  /** Send one already-serialized JSON string. Must not throw. */
  send(json: string): void;
  /** Called once at startup with the hello payload. */
  hello(json: string): void;
  close(): void;
  /** Fires when the transport is (re)connected or lost. */
  onStateChange?: (connected: boolean) => void;
  /**
   * Fires when a message arrives *from* the editor (e.g. a live `config`
   * push). Transports that have no receive channel — the HTTP batch
   * transport, which only ever does fire-and-forget POSTs — simply never
   * call this, and the agent keeps running with its startup config.
   */
  onMessage?: (json: string) => void;
}

export interface AgentConfig {
  sessionId: string;
  runtime: RuntimeKind;
  label: string;
  token: string;
  pid?: number;
  cwd?: string;
  /** How often buffered events are flushed, in ms. */
  flushIntervalMs: number;
  /** Bounded buffer size; oldest events are dropped past this. */
  maxBufferedEvents: number;
  /** Max events per outgoing batch. */
  maxBatchEvents: number;
  /**
   * Max approximate on-wire bytes per outgoing batch. `maxBatchEvents`
   * alone doesn't stop a batch of ordinary-sized events from adding up past
   * what the server accepts in one message (`maxPayloadBytes` in
   * server.ts) — the server rejects the *entire* batch when that happens,
   * and losing a whole batch is worse than sending more, smaller ones.
   * Starts at a conservative built-in default and gets tightened to the
   * server's real limit once its first `config` push arrives (see
   * `applyConfig`).
   */
  maxBatchBytes: number;
  objectDepth: number;
  maxStringLength: number;
  captureConsole: boolean;
  captureExpressions: boolean;
}

export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, 'sessionId' | 'token' | 'label' | 'runtime'> = {
  flushIntervalMs: 40,
  maxBufferedEvents: 2000,
  maxBatchEvents: 200,
  // Comfortably under the server's default 256 KiB `maxPayloadBytes` even
  // before a live `config` push (see applyConfig) narrows this to the
  // server's actual configured limit.
  maxBatchBytes: 196 * 1024,
  objectDepth: 3,
  maxStringLength: 4000,
  captureConsole: true,
  captureExpressions: true
};

/**
 * Approximate on-wire size of one event as JSON, used to keep a batch under
 * its byte budget without re-stringifying the whole batch on every push.
 * UTF-8 bytes (not `.length`) because JSON is emitted as UTF-8 and multi-byte
 * characters would otherwise be undercounted. Deliberately not `Buffer`: this
 * file is bundled for browsers too, where `Buffer` does not exist.
 */
function approxEventBytes(event: RuntimeEvent): number {
  return utf8ByteLength(JSON.stringify(event)) + 1; // +1 for the array separator
}

/**
 * `console.table` carries its full data in `event.table`, so its `args` only
 * feed one-line previews and the tree view. Serializing the same (possibly
 * huge) value twice at full fidelity would double both the CPU and the bytes
 * on the wire.
 */
const TABLE_ARG_SERIALIZE = { maxEntries: 25, maxNodes: 500, maxStringLength: 200 } as const;

/** Share of a batch's byte budget one table may use (the rest is args/envelope/other events). */
const TABLE_BUDGET_SHARE = 0.6;

export class Agent {
  private readonly buffer: RuntimeEvent[] = [];
  private readonly counts = new Map<string, number>();
  private seq = 0;
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private paused = false;
  private disabled = false;

  constructor(private readonly config: AgentConfig, private readonly transport: AgentTransport) {
    const hello: HelloMessage = {
      t: 'hello',
      v: PROTOCOL_VERSION,
      token: config.token,
      sessionId: config.sessionId,
      runtime: config.runtime,
      label: config.label,
      pid: config.pid,
      cwd: config.cwd
    };
    try {
      this.transport.hello(JSON.stringify(hello));
    } catch {
      this.disabled = true;
    }
    this.transport.onMessage = (json) => this.handleServerMessage(json);
    this.startTimer();
  }

  /** Handle a raw message pushed from the editor (currently only `config`). */
  private handleServerMessage(json: string): void {
    try {
      const parsed = parseServerMessage(json);
      if (!parsed.ok) {
        return;
      }
      if (parsed.value.t === 'config') {
        this.applyConfig(parsed.value);
      } else if (parsed.value.t === 'reset') {
        this.resetCounts();
      }
    } catch {
      /* a bad push from the editor must never affect the host program */
    }
  }

  /**
   * Zero every per-probe execution counter, so the next captured event at
   * each probe reports `count: 1` instead of resuming from wherever it left
   * off. Pushed from the editor when the user runs "Clear". Deliberately
   * leaves `seq` untouched — that counter orders events on the wire and must
   * stay monotonic for the life of the process.
   */
  resetCounts(): void {
    this.counts.clear();
  }

  /**
   * Apply capture switches pushed live from the editor (e.g. after the user
   * changes `runtimeLens.objectDepth` in settings). Takes effect on the next
   * captured value — nothing already serialized is retroactively deepened.
   */
  applyConfig(cfg: {
    captureConsole: boolean;
    captureExpressions: boolean;
    paused: boolean;
    objectDepth: number;
    maxPayloadBytes?: number;
  }): void {
    this.config.captureConsole = cfg.captureConsole;
    this.config.captureExpressions = cfg.captureExpressions;
    this.config.objectDepth = cfg.objectDepth;
    this.setPaused(cfg.paused);
    if (typeof cfg.maxPayloadBytes === 'number' && Number.isFinite(cfg.maxPayloadBytes) && cfg.maxPayloadBytes > 0) {
      // 75%: headroom for the batch envelope (sessionId/t/v/dropped) and
      // for approxEventBytes's necessarily approximate per-event accounting.
      this.config.maxBatchBytes = Math.max(1024, Math.floor(cfg.maxPayloadBytes * 0.75));
    }
  }

  private startTimer(): void {
    if (this.timer !== undefined) {
      return;
    }
    this.timer = setInterval(() => this.flush(), this.config.flushIntervalMs);
    // Never hold a Node process open just to flush telemetry.
    const maybeUnref = this.timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') {
      maybeUnref.unref();
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Console capture entry point injected by the transform. */
  c(level: LogLevel, id: string, file: string, line: number, column: number, args: unknown[]): void {
    try {
      if (!this.disabled && !this.paused && this.config.captureConsole) {
        const count = this.bump(id);
        const serializeOptions = { depth: this.config.objectDepth, maxStringLength: this.config.maxStringLength };
        const serializedArgs = args.map((a, index) =>
          serialize(a, level === 'table' && index === 0 ? { ...serializeOptions, ...TABLE_ARG_SERIALIZE } : serializeOptions)
        );
        const table = level === 'table' ? this.buildTable(args) : undefined;
        this.push({
          t: 'log',
          id,
          seq: this.seq++,
          ts: Date.now(),
          count,
          level,
          loc: { file, line, column },
          args: serializedArgs,
          ...(table ? { table } : {})
        });
      }
    } catch {
      /* capture must never break the call */
    }
    // Resolve the method at call time. Applications sometimes monkey-patch
    // console methods after the agent is initialized; keeping a constructor-time
    // function reference silently bypasses that patch and changes observable
    // console behaviour. Reflect.apply also preserves the console receiver.
    const consoleObject = globalThis.console as unknown as Record<string, unknown>;
    const original = consoleObject?.[level];
    // Match the natural failure mode of `console[level](...)` when a method
    // has been replaced with a non-callable value instead of silently eating
    // the user's call.
    Reflect.apply(original as (...values: unknown[]) => unknown, consoleObject, args);
  }

  /** Expression probe entry point; returns its input unchanged. */
  e<T>(id: string, file: string, line: number, column: number, expr: string, value: T): T {
    try {
      if (!this.disabled && !this.paused && this.config.captureExpressions) {
        const count = this.bump(id);
        this.push({
          t: 'expr',
          id,
          seq: this.seq++,
          ts: Date.now(),
          count,
          expr,
          loc: { file, line, column },
          value: serialize(value, {
            depth: this.config.objectDepth,
            maxStringLength: this.config.maxStringLength
          })
        });
      }
    } catch {
      /* ignore */
    }
    return value;
  }

  /** Report a runtime error (wired to uncaughtException / window.onerror). */
  reportError(err: unknown, loc: { file: string; line: number; column: number }, fatal: boolean): void {
    try {
      const id = `err:${loc.file}:${loc.line}`;
      const count = this.bump(id);
      const error = err instanceof Error ? err : new Error(String(err));
      this.push({
        t: 'error',
        id,
        seq: this.seq++,
        ts: Date.now(),
        count,
        loc,
        message: error.message,
        stack: error.stack,
        fatal
      });
      this.flush();
    } catch {
      /* ignore */
    }
  }

  /**
   * `undefined` means "not really a table": real `console.table` only grids
   * arrays, plain objects, Maps and Sets, and prints anything else (a
   * primitive, `null`, a bare function) the way `console.log` would. The
   * caller then keeps the event but leaves off `.table`, so the Webview shows
   * the normal one-line preview instead of a fabricated one-row grid.
   */
  private buildTable(args: unknown[]): ReturnType<typeof normalizeConsoleTable> | undefined {
    if (!isTableSource(args[0])) {
      return undefined;
    }
    try {
      return normalizeConsoleTable(args, {
        depth: this.config.objectDepth,
        maxStringLength: this.config.maxStringLength,
        maxBytes: Math.max(2048, Math.floor(this.config.maxBatchBytes * TABLE_BUDGET_SHARE))
      });
    } catch (err) {
      // The normalizer guards every intrinsic a hostile value can break, so
      // reaching here means a bug in it. Keep the event (and its args) and
      // show *why* the table is missing instead of dropping the whole call.
      return {
        columns: ['Value'],
        rows: [
          {
            key: '0',
            cells: [{ k: 'unserializable', hint: `console.table could not be displayed: ${errorText(err)}` }]
          }
        ],
        truncated: true
      };
    }
  }

  private bump(id: string): number {
    const next = (this.counts.get(id) ?? 0) + 1;
    this.counts.set(id, next);
    return next;
  }

  private push(event: RuntimeEvent): void {
    if (this.buffer.length >= this.config.maxBufferedEvents) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(event);
    if (this.buffer.length >= this.config.maxBatchEvents) {
      this.flush();
    }
  }

  /** Flush buffered events as one or more batches. Safe to call at any time. */
  flush(): void {
    if (this.disabled || this.buffer.length === 0) {
      return;
    }
    while (this.buffer.length > 0) {
      // Runs from a timer inside the user's process: a throw here would be an
      // uncaught exception in *their* app. Per rule 3 a failure disables the
      // agent instead.
      try {
        const events = this.takeNextBatch();
        const batch: BatchMessage = {
          t: 'batch',
          v: PROTOCOL_VERSION,
          sessionId: this.config.sessionId,
          events,
          dropped: this.dropped > 0 ? this.dropped : undefined
        };
        this.dropped = 0;
        this.transport.send(JSON.stringify(batch));
      } catch {
        this.disabled = true;
        return;
      }
    }
  }

  /**
   * Pull the next outgoing batch off the front of the buffer, bounded by
   * both `maxBatchEvents` and `maxBatchBytes`. A single event that alone
   * exceeds the byte budget is still sent by itself — there's nothing
   * smaller to split it into, and `flush()` must always make progress
   * rather than getting stuck retrying the same oversized head-of-buffer
   * event forever.
   */
  private takeNextBatch(): RuntimeEvent[] {
    const events: RuntimeEvent[] = [];
    let bytes = 2; // '[' + ']'
    while (events.length < this.config.maxBatchEvents && this.buffer.length > 0) {
      const size = approxEventBytes(this.buffer[0]);
      if (events.length > 0 && bytes + size > this.config.maxBatchBytes) {
        break;
      }
      events.push(this.buffer.shift() as RuntimeEvent);
      bytes += size;
    }
    return events;
  }

  dispose(reason = 'agent-dispose'): void {
    this.flush();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      this.transport.send(JSON.stringify({ t: 'bye', v: PROTOCOL_VERSION, sessionId: this.config.sessionId, reason }));
    } catch {
      /* ignore */
    }
    this.transport.close();
    this.disabled = true;
  }

  /** Diagnostics for tests and the `Show Diagnostics` command. */
  stats(): { buffered: number; dropped: number; probes: number; seq: number; disabled: boolean } {
    return {
      buffered: this.buffer.length,
      dropped: this.dropped,
      probes: this.counts.size,
      seq: this.seq,
      disabled: this.disabled
    };
  }
}


function errorText(err: unknown): string {
  try {
    return (err instanceof Error ? err.message : String(err)).slice(0, 200);
  } catch {
    return 'unknown error';
  }
}

/** A no-op stand-in used when no editor endpoint is configured. */
export function createNoopAgent(): Pick<Agent, 'c' | 'e'> {
  const consoleRef = globalThis.console as unknown as Record<string, ((...args: unknown[]) => void) | undefined>;
  return {
    c(level: LogLevel, _id: string, _file: string, _line: number, _column: number, args: unknown[]): void {
      consoleRef?.[level]?.(...args);
    },
    e<T>(_id: string, _file: string, _line: number, _column: number, _expr: string, value: T): T {
      return value;
    }
  };
}
