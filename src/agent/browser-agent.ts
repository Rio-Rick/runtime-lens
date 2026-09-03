/**
 * Browser/edge entry point. Bundled by esbuild into a single ESM file that the
 * Vite plugin serves from a virtual module, so the user's project never gains
 * a dependency on Runtime Lens.
 *
 * Configuration arrives on `globalThis.__RUNTIME_LENS_CONFIG__`, which the
 * virtual module prepends. If it is missing we degrade to a pass-through agent
 * so a stale bundle can never break someone's app.
 */
import { Agent, DEFAULT_AGENT_CONFIG, createNoopAgent, type AgentConfig } from './core';
import { createGlobalWebSocketTransport, type WebSocketLike } from './ws-transport';

interface BrowserConfig {
  port: number;
  token: string;
  host?: string;
  label?: string;
  runtime?: 'browser' | 'edge';
  objectDepth?: number;
}

declare const __RUNTIME_LENS_CONFIG__: BrowserConfig | undefined;

function readConfig(): BrowserConfig | undefined {
  const fromGlobal = (globalThis as { __RUNTIME_LENS_CONFIG__?: BrowserConfig }).__RUNTIME_LENS_CONFIG__;
  if (fromGlobal && typeof fromGlobal.port === 'number' && typeof fromGlobal.token === 'string') {
    return fromGlobal;
  }
  if (typeof __RUNTIME_LENS_CONFIG__ !== 'undefined' && __RUNTIME_LENS_CONFIG__) {
    return __RUNTIME_LENS_CONFIG__;
  }
  return undefined;
}

function create(): Agent | ReturnType<typeof createNoopAgent> {
  const config = readConfig();
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!config || typeof WS !== 'function') {
    return createNoopAgent();
  }
  const host = config.host ?? '127.0.0.1';
  const sessionId = `web-${Math.random().toString(36).slice(2, 10)}`;
  const transport = createGlobalWebSocketTransport(
    WS,
    `ws://${host}:${config.port}/rl?token=${encodeURIComponent(config.token)}`
  );
  const agentConfig: AgentConfig = {
    ...DEFAULT_AGENT_CONFIG,
    sessionId,
    token: config.token,
    runtime: config.runtime ?? 'browser',
    label: config.label ?? browserLabel(),
    objectDepth: config.objectDepth ?? DEFAULT_AGENT_CONFIG.objectDepth
  };
  const agent = new Agent(agentConfig, transport);

  const globalWithHooks = globalThis as {
    addEventListener?: (type: string, listener: (ev: unknown) => void) => void;
    location?: { pathname?: string };
  };
  if (typeof globalWithHooks.addEventListener === 'function') {
    globalWithHooks.addEventListener('error', (ev: unknown) => {
      const e = ev as { message?: string; filename?: string; lineno?: number; colno?: number; error?: unknown };
      agent.reportError(e.error ?? e.message ?? 'error', {
        file: e.filename ?? 'unknown',
        line: e.lineno ?? 1,
        column: e.colno ?? 0
      }, false);
    });
    globalWithHooks.addEventListener('unhandledrejection', (ev: unknown) => {
      const e = ev as { reason?: unknown };
      agent.reportError(e.reason ?? 'unhandled rejection', { file: 'unknown', line: 1, column: 0 }, false);
    });
    globalWithHooks.addEventListener('beforeunload', () => agent.flush());
  }
  return agent;
}

function browserLabel(): string {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  const loc = (globalThis as { location?: { pathname?: string } }).location;
  const ua = nav?.userAgent ?? 'browser';
  const short = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'browser';
  return `${short} ${loc?.pathname ?? ''}`.trim();
}

const browserAgent = create();
export default browserAgent;
