import * as http from 'node:http';
import { Agent, DEFAULT_AGENT_CONFIG, type AgentConfig, type AgentTransport } from './core';
import { createGlobalWebSocketTransport, type WebSocketLike } from './ws-transport';

export interface NodeEndpoint {
  host: string;
  port: number;
  token: string;
}

/**
 * HTTP-batch transport.
 *
 * Why HTTP and not only WebSocket? A stable global `WebSocket` only landed in
 * Node 22, and shipping a `ws` copy into the *user's* process is unacceptable
 * (version conflicts, bundler noise, install weight). The extension therefore
 * exposes both a WebSocket endpoint and a `POST /ingest` endpoint that share
 * one validation path, and the Node agent picks whichever is available. HTTP
 * keep-alive over loopback costs ~50µs per batch, which is irrelevant next to
 * the 40 ms flush interval.
 */
export function createHttpTransport(endpoint: NodeEndpoint): AgentTransport {
  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 2, keepAliveMsecs: 5000 });
  let broken = false;

  const post = (json: string): void => {
    if (broken) {
      return;
    }
    try {
      const req = http.request(
        {
          host: endpoint.host,
          port: endpoint.port,
          path: '/ingest',
          method: 'POST',
          agent: keepAliveAgent,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(json),
            'x-runtime-lens-token': endpoint.token
          }
        },
        (res) => {
          // Drain so the socket can be reused.
          res.resume();
          if (res.statusCode === 401 || res.statusCode === 426) {
            broken = true;
          }
        }
      );
      req.setTimeout(2000, () => req.destroy());
      req.on('error', () => {
        /* editor closed: stay silent, keep the app running */
      });
      // A keep-alive socket is an active handle that would otherwise hold
      // the host process open indefinitely just to keep this connection
      // warm — the same "never hold the process open" bug fixed in
      // ws-transport.ts. unref() lets the host exit normally once its own
      // work is done; the socket still delivers whatever was already
      // written to it.
      req.on('socket', (sock) => sock.unref());
      req.end(json);
    } catch {
      broken = true;
    }
  };

  return {
    hello: post,
    send: post,
    close(): void {
      keepAliveAgent.destroy();
    }
  };
}

/** WebSocket transport used when the host runtime provides a global WebSocket. */
export function createWebSocketTransport(endpoint: NodeEndpoint): AgentTransport | undefined {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (typeof WS !== 'function') {
    return undefined;
  }
  return createGlobalWebSocketTransport(WS, `ws://${endpoint.host}:${endpoint.port}/rl?token=${endpoint.token}`);
}

export function readNodeEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): NodeEndpoint | undefined {
  const port = Number.parseInt(env.RUNTIME_LENS_PORT ?? '', 10);
  const token = env.RUNTIME_LENS_TOKEN ?? '';
  if (!Number.isInteger(port) || port <= 0 || token.length === 0) {
    return undefined;
  }
  return { host: env.RUNTIME_LENS_HOST || '127.0.0.1', port, token };
}

export interface CreateNodeAgentOptions {
  endpoint: NodeEndpoint;
  label?: string;
  sessionId?: string;
  transportKind?: 'auto' | 'ws' | 'http';
  overrides?: Partial<AgentConfig>;
  installProcessHooks?: boolean;
}

export function createNodeAgent(options: CreateNodeAgentOptions): Agent {
  const { endpoint } = options;
  const kind = options.transportKind ?? (process.env.RUNTIME_LENS_TRANSPORT as 'auto' | 'ws' | 'http') ?? 'auto';
  const transport =
    (kind === 'ws' || kind === 'auto' ? createWebSocketTransport(endpoint) : undefined) ??
    createHttpTransport(endpoint);

  const config: AgentConfig = {
    ...DEFAULT_AGENT_CONFIG,
    sessionId: options.sessionId ?? `node-${process.pid}-${Date.now().toString(36)}`,
    token: endpoint.token,
    runtime: 'node',
    label: options.label ?? `node ${process.version} (pid ${process.pid})`,
    pid: process.pid,
    cwd: process.cwd(),
    objectDepth: Number.parseInt(process.env.RUNTIME_LENS_DEPTH ?? '', 10) || DEFAULT_AGENT_CONFIG.objectDepth,
    ...options.overrides
  };

  const agent = new Agent(config, transport);

  if (options.installProcessHooks !== false) {
    installProcessHooks(agent, config.cwd ?? process.cwd());
  }

  return agent;
}

/** True when the host process picked an unhandled-rejection mode itself (`--unhandled-rejections=...`). */
function hasExplicitRejectionMode(proc: NodeJS.Process): boolean {
  const flags = [...proc.execArgv, ...(proc.env.NODE_OPTIONS ?? '').split(/\s+/)];
  return flags.some((flag) => flag.startsWith('--unhandled-rejections'));
}

/**
 * Report crashes and unhandled rejections without changing what the program
 * does (rule 1 of the agent: never change observable behaviour).
 *
 * Merely *adding* a listener changes Node's behaviour: with an
 * `unhandledRejection` listener installed Node no longer crashes on a
 * rejection nor prints it, and re-throwing from an `uncaughtException`
 * listener changes the exit code (1 -> 7) and the printed stack. So:
 *  - crashes are observed through `uncaughtExceptionMonitor`, which exists for
 *    exactly this and leaves Node's default handling untouched;
 *  - for rejections the only hook is the listener, so when ours is the only
 *    one (and the app chose no `--unhandled-rejections` mode) it restores the
 *    default by raising the rejection as an uncaught exception, as Node does.
 */
export function installProcessHooks(agent: Agent, file: string, proc: NodeJS.Process = process): void {
  const loc = { file, line: 1, column: 0 };
  const reported = new WeakSet<object>();
  const report = (err: unknown, fatal: boolean): void => {
    if (typeof err === 'object' && err !== null) {
      if (reported.has(err)) {
        return; // e.g. a rejection we re-raise reaches the crash monitor too
      }
      reported.add(err);
    }
    agent.reportError(err, loc, fatal);
  };

  proc.on('uncaughtExceptionMonitor', (err: unknown) => report(err, true));
  proc.on('unhandledRejection', (reason: unknown) => {
    const restoreDefault = proc.listenerCount('unhandledRejection') === 1 && !hasExplicitRejectionMode(proc);
    if (!restoreDefault) {
      report(reason, false);
      return;
    }
    const crash = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${safeString(reason)}`);
    report(crash, true);
    throw crash;
  });
  proc.on('beforeExit', () => agent.flush());
  proc.on('exit', () => agent.flush());
}

function safeString(value: unknown): string {
  try {
    return String(value).slice(0, 500);
  } catch {
    return '<unprintable>';
  }
}
