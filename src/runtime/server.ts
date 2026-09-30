import * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ABSOLUTE_MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type RuntimeEvent,
  type RuntimeKind,
  type ServerErrorMessage,
  type ServerMessage
} from '../protocol';
import { TypedEmitter } from '../utils/events';
import { createSessionToken, tokensMatch } from '../utils/token';
import { findFreePort } from './port';

export interface SessionInfo {
  sessionId: string;
  runtime: RuntimeKind;
  label: string;
  pid?: number;
  cwd?: string;
  connectedAt: number;
  transport: 'ws' | 'http';
  eventCount: number;
  droppedByAgent: number;
}

export interface ServerEvents {
  listening: { port: number; token: string };
  events: { sessionId: string; events: RuntimeEvent[]; dropped: number };
  'session-open': SessionInfo;
  'session-close': { sessionId: string; reason?: string };
  'protocol-error': { code: ServerErrorMessage['code']; message: string; remote?: string };
  error: { error: Error };
  stopped: Record<string, never>;
}

export interface RuntimeServerOptions {
  /** Preferred port; 0 (default) auto-selects a free ephemeral port. */
  preferredPort?: number;
  /** Maximum accepted size of a single message/body in bytes. */
  maxPayloadBytes?: number;
  /** Loopback host. Bound to 127.0.0.1 and never to 0.0.0.0. */
  host?: '127.0.0.1' | 'localhost';
  /** Injected for tests; a fresh 256-bit token is generated per start otherwise. */
  token?: string;
  /** Live capture switches pushed to agents on connect. */
  getAgentConfig?: () => { captureConsole: boolean; captureExpressions: boolean; paused: boolean; objectDepth: number };
}

const DEFAULT_MAX_PAYLOAD = 256 * 1024;

/**
 * Per-probe execution-count bookkeeping for one session. `last` is the most
 * recent count the agent reported; `base` is what `last` was when the user
 * pressed Clear. Displayed counts are `count - base`.
 */
interface ProbeCount {
  last: number;
  base: number;
}

/**
 * Localhost-only ingest server.
 *
 * Security posture (this listens on a developer machine, so it matters):
 *  - binds 127.0.0.1 exclusively, so nothing on the LAN can reach it;
 *  - requires a per-start 256-bit token on the WebSocket upgrade *and* on
 *    every HTTP ingest request, compared in constant time;
 *  - rejects cross-origin browser connections that do not come from a
 *    localhost dev server origin;
 *  - caps every payload, caps events per batch, and validates every field
 *    before a single byte reaches the UI layer.
 */
export class RuntimeServer {
  readonly emitter = new TypedEmitter<ServerEvents>();

  private httpServer: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly sockets = new Map<WebSocket, string>();
  /** Keyed by the session object so the bookkeeping dies with the session. */
  private readonly probeCounts = new WeakMap<SessionInfo, Map<string, ProbeCount>>();
  private tokenValue = '';
  private portValue = 0;
  private running = false;
  private totalEvents = 0;
  private rejected = 0;

  constructor(private readonly options: RuntimeServerOptions = {}) {}

  get port(): number {
    return this.portValue;
  }

  get token(): string {
    return this.tokenValue;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get maxPayloadBytes(): number {
    const configured = this.options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
    return Math.min(ABSOLUTE_MAX_PAYLOAD_BYTES, Math.max(1024, Math.floor(configured)));
  }

  listSessions(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  /**
   * Forcibly end a session: closes its live WebSocket connection (if any)
   * and drops it from the session list. Safe to call on a session with no
   * live connection (an HTTP-transport session whose process exited without
   * ever sending `bye` just sits in the list otherwise) — there's nothing to
   * close, so this simply clears the stale entry. A still-running Node or
   * browser agent reconnects on its own next flush (see ws-transport.ts),
   * the same as after any other dropped connection — this isn't a way to
   * silence a session for good, only to clear it from the current view.
   * Returns `false` if `sessionId` wasn't a known session.
   */
  disconnectSession(sessionId: string, reason = 'disconnected-by-user'): boolean {
    return this.evictSession(sessionId, reason);
  }

  stats(): { port: number; sessions: number; totalEvents: number; rejected: number; running: boolean } {
    return {
      port: this.portValue,
      sessions: this.sessions.size,
      totalEvents: this.totalEvents,
      rejected: this.rejected,
      running: this.running
    };
  }

  async start(): Promise<{ port: number; token: string }> {
    if (this.running) {
      return { port: this.portValue, token: this.tokenValue };
    }
    this.tokenValue = this.options.token ?? createSessionToken();
    const host = this.options.host ?? '127.0.0.1';
    const port = await findFreePort(this.options.preferredPort ?? 0, host);

    this.httpServer = http.createServer((req, res) => this.handleHttp(req, res));
    this.httpServer.on('error', (error) => this.emitter.emit('error', { error }));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: this.maxPayloadBytes });

    this.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    try {
      await new Promise<void>((resolve, reject) => {
        const server = this.httpServer as http.Server;
        const onError = (err: Error): void => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
    } catch (err) {
      // A failed listen can leave the HTTP server and WebSocket server objects
      // allocated even though `running` was never reached. Release them here
      // so a subsequent Start can retry cleanly (especially after EADDRINUSE).
      try {
        this.wss?.close();
      } catch {
        /* ignore cleanup errors */
      }
      try {
        this.httpServer?.close();
      } catch {
        /* ignore cleanup errors */
      }
      this.wss = undefined;
      this.httpServer = undefined;
      this.portValue = 0;
      this.tokenValue = '';
      throw err;
    }

    const address = this.httpServer.address();
    this.portValue = typeof address === 'object' && address ? address.port : port;
    this.running = true;
    this.emitter.emit('listening', { port: this.portValue, token: this.tokenValue });
    return { port: this.portValue, token: this.tokenValue };
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const [socket, sessionId] of this.sockets) {
      try {
        socket.close(1000, 'server-stop');
      } catch {
        /* ignore */
      }
      this.emitter.emit('session-close', { sessionId, reason: 'server-stop' });
    }
    this.sockets.clear();
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.closeAllConnections?.();
      this.httpServer.close(() => resolve());
    });
    this.wss = undefined;
    this.httpServer = undefined;
    this.portValue = 0;
    this.emitter.emit('stopped', {} as Record<string, never>);
  }

  /** Broadcast the current capture configuration to every connected agent. */
  broadcastConfig(): void {
    const cfg = this.options.getAgentConfig?.();
    if (!cfg) {
      return;
    }
    const message: ServerMessage = { t: 'config', v: PROTOCOL_VERSION, ...cfg, maxPayloadBytes: this.maxPayloadBytes };
    const json = JSON.stringify(message);
    for (const socket of this.sockets.keys()) {
      try {
        socket.send(json);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Start every counter over, for "Clear": per-session event/dropped totals,
   * the server's running total, and the execution counts (`× N`) of every
   * probe.
   *
   * The agent-side counts can't simply be zeroed from here — agents on the
   * HTTP transport have no receive channel, and events already in flight when
   * Clear is pressed still carry their old counts. So the server remembers
   * where each probe's count stood and re-bases later events against it (see
   * `rebase`). `broadcastReset` additionally zeroes live WebSocket agents;
   * `rebase` notices that (the count drops below the baseline) and stops
   * subtracting.
   */
  resetCounters(): void {
    this.totalEvents = 0;
    for (const session of this.sessions.values()) {
      session.eventCount = 0;
      session.droppedByAgent = 0;
      for (const count of this.probeCounts.get(session)?.values() ?? []) {
        count.base = count.last;
      }
    }
  }

  /** Display counts relative to the last Clear. Never mutates the input events. */
  private rebase(session: SessionInfo, events: RuntimeEvent[]): RuntimeEvent[] {
    let counts = this.probeCounts.get(session);
    if (!counts) {
      counts = new Map();
      this.probeCounts.set(session, counts);
    }
    return events.map((event) => {
      let entry = counts.get(event.id);
      if (!entry) {
        entry = { last: 0, base: 0 };
        counts.set(event.id, entry);
      }
      if (entry.base > 0 && event.count <= entry.base) {
        // The agent's counter restarted (live reset, or the process did):
        // the baseline no longer applies.
        entry.base = 0;
      }
      entry.last = event.count;
      return entry.base > 0 ? { ...event, count: event.count - entry.base } : event;
    });
  }

  /**
   * Tell every connected agent to zero its per-probe execution counters
   * (see `ServerResetMessage`). Called when the user clears the log —
   * without this, a probe's `× N` counter would keep counting up from its
   * pre-clear value on the next event, since that count is computed in the
   * agent's process, not derived from the (now-empty) local history.
   *
   * Only reaches agents connected over WebSocket: the HTTP batch transport
   * (used when no global `WebSocket` is available, e.g. Node < 22) has no
   * receive channel, the same limitation `broadcastConfig` already has for
   * live capture-switch pushes. `sessionsUnreachableForReset()` reports
   * which currently-connected sessions that affects.
   */
  broadcastReset(): void {
    const message: ServerMessage = { t: 'reset', v: PROTOCOL_VERSION };
    const json = JSON.stringify(message);
    for (const socket of this.sockets.keys()) {
      try {
        socket.send(json);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Sessions that `broadcastReset` cannot reach because they connected over
   * the receive-less HTTP transport. Their agent-side counters keep
   * incrementing; `resetCounters` compensates by re-basing what they report.
   */
  sessionsUnreachableForReset(): SessionInfo[] {
    return [...this.sessions.values()].filter((s) => s.transport === 'http');
  }

  // ---------------------------------------------------------------- upgrade

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.portValue}`);
    if (url.pathname !== '/rl') {
      this.rejectUpgrade(socket, 404, 'unknown endpoint');
      return;
    }
    const token = url.searchParams.get('token') ?? (req.headers['x-runtime-lens-token'] as string | undefined) ?? '';
    if (!tokensMatch(this.tokenValue, token)) {
      this.rejected++;
      this.emitter.emit('protocol-error', { code: 'bad-token', message: 'upgrade rejected: bad token', remote: req.socket.remoteAddress ?? undefined });
      this.rejectUpgrade(socket, 401, 'bad token');
      return;
    }
    if (!isLocalRequest(req)) {
      this.rejected++;
      this.emitter.emit('protocol-error', { code: 'bad-token', message: 'upgrade rejected: non-local origin' });
      this.rejectUpgrade(socket, 403, 'non-local origin');
      return;
    }
    this.wss?.handleUpgrade(req, socket, head, (ws) => this.attachSocket(ws, this.tokenValue));
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    try {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    } finally {
      socket.destroy();
    }
  }

  /**
   * Close any live socket bound to `sessionId` and drop it from the session
   * list, emitting exactly one `session-close` if there was anything to
   * remove. Shared by the reconnect race handler below (which excludes the
   * new socket that's replacing it) and the public `disconnectSession`.
   */
  private evictSession(sessionId: string, reason: string, excludeSocket?: WebSocket): boolean {
    let evicted = false;
    for (const [socket, boundId] of this.sockets) {
      if (boundId !== sessionId || socket === excludeSocket) {
        continue;
      }
      this.sockets.delete(socket);
      try {
        socket.close(1000, reason);
      } catch {
        /* ignore */
      }
      evicted = true;
    }
    if (this.sessions.delete(sessionId)) {
      evicted = true;
    }
    if (evicted) {
      this.emitter.emit('session-close', { sessionId, reason });
    }
    return evicted;
  }

  private attachSocket(ws: WebSocket, expectedToken: string): void {
    let boundSessionId: string | undefined;

    ws.on('message', (data, isBinary) => {
      const raw = isBinary ? (data as Buffer) : data.toString();
      const parsed = parseClientMessage(raw as string | Uint8Array, this.maxPayloadBytes, expectedToken);
      if (!parsed.ok) {
        this.rejected++;
        this.emitter.emit('protocol-error', { code: parsed.code, message: parsed.error });
        this.sendServerError(ws, parsed.code, parsed.error);
        if (parsed.code === 'bad-version' || parsed.code === 'bad-token') {
          ws.close(1008, parsed.code);
        }
        return;
      }

      const message = parsed.value;
      if (message.t === 'hello') {
        if (boundSessionId !== undefined) {
          this.rejectSocketMessage(ws, 'WebSocket session already authenticated');
          return;
        }

        // A reconnect can race the old socket's close event. Replace the old
        // connection atomically (excluding `ws` itself, though it can't be
        // registered yet at this point) so its later close handler cannot
        // delete the newly-connected session.
        this.evictSession(message.sessionId, 'replaced', ws);

        boundSessionId = message.sessionId;
        this.ingest(message, 'ws', ws);
        return;
      }

      if (boundSessionId === undefined) {
        this.rejectSocketMessage(ws, 'hello is required before batch/bye');
        return;
      }
      if (message.sessionId !== boundSessionId) {
        this.rejectSocketMessage(ws, 'sessionId does not match the authenticated WebSocket');
        return;
      }

      this.ingest(message, 'ws', ws);
      if (message.t === 'bye') {
        this.sockets.delete(ws);
        boundSessionId = undefined;
      }
    });
    ws.on('close', () => {
      const sessionId = this.sockets.get(ws);
      this.sockets.delete(ws);
      if (sessionId) {
        this.sessions.delete(sessionId);
        this.emitter.emit('session-close', { sessionId, reason: 'socket-closed' });
      }
    });
    ws.on('error', (error) => this.emitter.emit('error', { error }));
  }

  private rejectSocketMessage(ws: WebSocket, message: string): void {
    this.rejected++;
    this.emitter.emit('protocol-error', { code: 'bad-message', message });
    this.sendServerError(ws, 'bad-message', message);
    try {
      ws.close(1008, 'bad-message');
    } catch {
      /* ignore */
    }
  }

  private sendServerError(ws: WebSocket, code: ServerErrorMessage['code'], message: string): void {
    try {
      ws.send(JSON.stringify({ t: 'error', v: PROTOCOL_VERSION, code, message } satisfies ServerErrorMessage));
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------- http

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.portValue}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      const body = JSON.stringify({ ok: true, v: PROTOCOL_VERSION, ...this.stats() });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/ingest') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    if (!isLocalRequest(req)) {
      res.writeHead(403).end('non-local');
      return;
    }
    const token = (req.headers['x-runtime-lens-token'] as string | undefined) ?? url.searchParams.get('token') ?? '';
    if (!tokensMatch(this.tokenValue, token)) {
      this.rejected++;
      this.emitter.emit('protocol-error', { code: 'bad-token', message: 'ingest rejected: bad token' });
      res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized');
      return;
    }

    const declared = Number.parseInt((req.headers['content-length'] as string) ?? '0', 10);
    if (Number.isFinite(declared) && declared > this.maxPayloadBytes) {
      this.rejected++;
      this.emitter.emit('protocol-error', { code: 'too-large', message: `content-length ${declared} exceeds limit` });
      res.writeHead(413, { 'content-type': 'text/plain' }).end('payload too large');
      req.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > this.maxPayloadBytes) {
        this.rejected++;
        this.emitter.emit('protocol-error', { code: 'too-large', message: `streamed body exceeded ${this.maxPayloadBytes} bytes` });
        res.writeHead(413, { 'content-type': 'text/plain' }).end('payload too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.writableEnded) {
        return;
      }
      const parsed = parseClientMessage(Buffer.concat(chunks), this.maxPayloadBytes, undefined);
      if (!parsed.ok) {
        this.rejected++;
        this.emitter.emit('protocol-error', { code: parsed.code, message: parsed.error });
        const body = JSON.stringify({ t: 'error', v: PROTOCOL_VERSION, code: parsed.code, message: parsed.error });
        res.writeHead(parsed.code === 'too-large' ? 413 : 400, { 'content-type': 'application/json' }).end(body);
        return;
      }
      const received = this.ingest(parsed.value, 'http');
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ t: 'ack', v: PROTOCOL_VERSION, received })
      );
    });
    req.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(400).end('bad request');
      }
    });
  }

  // ----------------------------------------------------------------- ingest

  private ingest(message: ClientMessage, transport: 'ws' | 'http', ws?: WebSocket): number {
    switch (message.t) {
      case 'hello': {
        const info: SessionInfo = {
          sessionId: message.sessionId,
          runtime: message.runtime,
          label: message.label,
          pid: message.pid,
          cwd: message.cwd,
          connectedAt: Date.now(),
          transport,
          eventCount: 0,
          droppedByAgent: 0
        };
        this.sessions.set(message.sessionId, info);
        if (ws) {
          this.sockets.set(ws, message.sessionId);
          const cfg = this.options.getAgentConfig?.();
          if (cfg) {
            try {
              ws.send(
                JSON.stringify({ t: 'config', v: PROTOCOL_VERSION, ...cfg, maxPayloadBytes: this.maxPayloadBytes } satisfies ServerMessage)
              );
            } catch {
              /* ignore */
            }
          }
        }
        this.emitter.emit('session-open', info);
        return 0;
      }
      case 'batch': {
        let session = this.sessions.get(message.sessionId);
        if (!session) {
          // HTTP agents may be restarted by a bundler without a fresh hello.
          session = {
            sessionId: message.sessionId,
            runtime: 'unknown',
            label: `${transport} session ${message.sessionId}`,
            connectedAt: Date.now(),
            transport,
            eventCount: 0,
            droppedByAgent: 0
          };
          this.sessions.set(message.sessionId, session);
          this.emitter.emit('session-open', session);
        }
        session.eventCount += message.events.length;
        session.droppedByAgent += message.dropped ?? 0;
        this.totalEvents += message.events.length;
        this.emitter.emit('events', {
          sessionId: message.sessionId,
          events: this.rebase(session, message.events),
          dropped: message.dropped ?? 0
        });
        return message.events.length;
      }
      case 'bye': {
        this.sessions.delete(message.sessionId);
        this.emitter.emit('session-close', { sessionId: message.sessionId, reason: message.reason });
        return 0;
      }
      default:
        return 0;
    }
  }
}

/** Only accept connections that originate from this machine. */
export function isLocalRequest(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? '';
  const localRemote =
    remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1' || remote === '' || remote === 'localhost';
  if (!localRemote) {
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const host = new URL(origin).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1') {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}
