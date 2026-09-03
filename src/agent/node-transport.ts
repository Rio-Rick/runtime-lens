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
    const loc = { file: config.cwd ?? process.cwd(), line: 1, column: 0 };
    process.on('uncaughtException', (err) => {
      agent.reportError(err, loc, true);
      throw err;
    });
    process.on('unhandledRejection', (reason) => {
      agent.reportError(reason, loc, false);
    });
    process.on('beforeExit', () => agent.flush());
    process.on('exit', () => agent.flush());
  }

  return agent;
}
