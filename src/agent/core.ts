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
  objectDepth: number;
  maxStringLength: number;
  captureConsole: boolean;
  captureExpressions: boolean;
}

export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, 'sessionId' | 'token' | 'label' | 'runtime'> = {
  flushIntervalMs: 40,
  maxBufferedEvents: 2000,
  maxBatchEvents: 200,
  objectDepth: 3,
  maxStringLength: 4000,
  captureConsole: true,
  captureExpressions: true
};

type ConsoleMethod = (...args: unknown[]) => void;

export class Agent {
  private readonly buffer: RuntimeEvent[] = [];
  private readonly counts = new Map<string, number>();
  private readonly originalConsole: Partial<Record<LogLevel, ConsoleMethod>> = {};
  private seq = 0;
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private paused = false;
  private disabled = false;

  constructor(private readonly config: AgentConfig, private readonly transport: AgentTransport) {
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'table'] as LogLevel[]) {
      const target = (globalThis.console as unknown as Record<string, ConsoleMethod>)?.[level];
      if (typeof target === 'function') {
        this.originalConsole[level] = target.bind(globalThis.console);
      }
    }
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
      if (parsed.ok && parsed.value.t === 'config') {
        this.applyConfig(parsed.value);
      }
    } catch {
      /* a bad push from the editor must never affect the host program */
    }
  }

  /**
   * Apply capture switches pushed live from the editor (e.g. after the user
   * changes `runtimeLens.objectDepth` in settings). Takes effect on the next
   * captured value — nothing already serialized is retroactively deepened.
   */
  applyConfig(cfg: { captureConsole: boolean; captureExpressions: boolean; paused: boolean; objectDepth: number }): void {
    this.config.captureConsole = cfg.captureConsole;
    this.config.captureExpressions = cfg.captureExpressions;
    this.config.objectDepth = cfg.objectDepth;
    this.setPaused(cfg.paused);
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
    const original = this.originalConsole[level];
    try {
      if (!this.disabled && !this.paused && this.config.captureConsole) {
        const count = this.bump(id);
        this.push({
          t: 'log',
          id,
          seq: this.seq++,
          ts: Date.now(),
          count,
          level,
          loc: { file, line, column },
          args: args.map((a) =>
            serialize(a, { depth: this.config.objectDepth, maxStringLength: this.config.maxStringLength })
          )
        });
      }
    } catch {
      /* capture must never break the call */
    }
    if (original) {
      original(...args);
    }
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
      const events = this.buffer.splice(0, this.config.maxBatchEvents);
      const batch: BatchMessage = {
        t: 'batch',
        v: PROTOCOL_VERSION,
        sessionId: this.config.sessionId,
        events,
        dropped: this.dropped > 0 ? this.dropped : undefined
      };
      this.dropped = 0;
      try {
        this.transport.send(JSON.stringify(batch));
      } catch {
        this.disabled = true;
        return;
      }
    }
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

/** A no-op stand-in used when no editor endpoint is configured. */
export function createNoopAgent(): Pick<Agent, 'c' | 'e'> {
  const consoleRef = globalThis.console as unknown as Record<string, ConsoleMethod | undefined>;
  return {
    c(level: LogLevel, _id: string, _file: string, _line: number, _column: number, args: unknown[]): void {
      consoleRef?.[level]?.(...args);
    },
    e<T>(_id: string, _file: string, _line: number, _column: number, _expr: string, value: T): T {
      return value;
    }
  };
}
