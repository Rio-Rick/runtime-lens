import type { AgentTransport } from './core';

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/**
 * Node's global `WebSocket` (stable since Node 22, the runtime this file
 * targets whenever it's loaded inside Node rather than a browser) has no
 * public API to `unref()` the socket it opens. Left alone, that socket is an
 * active handle that keeps the event loop — and therefore the *host* Node
 * process — running for as long as the connection to the editor stays open,
 * even after the host program has finished all of its own work. That breaks
 * the same "never hold the process open just to flush telemetry" contract
 * the agent's flush timer already follows (see core.ts): a one-shot script
 * would otherwise hang forever instead of exiting once it's done.
 *
 * `process._getActiveHandles()` is undocumented but has been present and
 * stable for well over a decade (it backs tools like `wtfnode`), and is the
 * only way to reach the handle a WHATWG WebSocket doesn't expose. This is
 * best-effort: outside Node (browsers, workers without that internal) it's a
 * no-op, which is correct there too — a browser tab isn't kept alive by an
 * open socket the way a Node process is.
 */
function unrefNewNodeHandles(before: ReadonlySet<unknown>, targetUrl: string): void {
  const proc = (globalThis as { process?: unknown }).process as
    | { _getActiveHandles?: () => unknown[] }
    | undefined;
  const getActiveHandles = proc?._getActiveHandles;
  if (typeof getActiveHandles !== 'function') {
    return;
  }

  let endpoint: { port: number; hosts: Set<string> };
  try {
    const url = new URL(targetUrl);
    const defaultPort = url.protocol === 'wss:' ? 443 : 80;
    const port = Number(url.port || defaultPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return;
    }
    const hosts = new Set([url.hostname]);
    if (url.hostname === 'localhost') {
      hosts.add('127.0.0.1');
      hosts.add('::1');
    }
    endpoint = { port, hosts };
  } catch {
    return;
  }

  for (const handle of getActiveHandles.call(proc)) {
    if (before.has(handle) || !isMatchingNodeSocket(handle, endpoint)) {
      continue;
    }
    const unref = (handle as { unref?: () => void } | null)?.unref;
    if (typeof unref === 'function') {
      unref.call(handle);
    }
  }
}

function isMatchingNodeSocket(
  handle: unknown,
  endpoint: { port: number; hosts: Set<string> }
): boolean {
  if (handle === null || typeof handle !== 'object') {
    return false;
  }
  const candidate = handle as {
    constructor?: { name?: string };
    remotePort?: number;
    remoteAddress?: string;
    destroyed?: boolean;
  };
  const name = candidate.constructor?.name;
  if (name !== 'Socket' && name !== 'TLSSocket') {
    return false;
  }
  if (candidate.destroyed === true || candidate.remotePort !== endpoint.port || typeof candidate.remoteAddress !== 'string') {
    return false;
  }
  return endpoint.hosts.has(candidate.remoteAddress);
}

function activeNodeHandleSnapshot(): ReadonlySet<unknown> {
  const proc = (globalThis as { process?: unknown }).process as
    | { _getActiveHandles?: () => unknown[] }
    | undefined;
  const getActiveHandles = proc?._getActiveHandles;
  return typeof getActiveHandles === 'function' ? new Set(getActiveHandles.call(proc)) : new Set();
}

/** First retry delay after a connection attempt that never opened; doubles per consecutive failure. */
const RECONNECT_BASE_MS = 250;
/** Ceiling for the retry delay, so a long-gone editor costs one cheap attempt every few seconds. */
const RECONNECT_MAX_MS = 10_000;

/**
 * Shared WebSocket transport (browser + modern Node). Buffers up to 200
 * messages while the socket opens, then drains them in order.
 *
 * Reconnect rules (this runs inside the *user's* process, so it must never
 * become a busy loop):
 *  - a connection that dropped after having been open is retried at once;
 *  - one that never opened (editor closed, token no longer valid) is retried
 *    with exponential backoff, capped at `RECONNECT_MAX_MS`;
 *  - events from a socket that has already been replaced are ignored, so a
 *    late `close` of the old socket can't tear down the new one.
 */
export function createGlobalWebSocketTransport(
  WebSocketCtor: new (url: string) => WebSocketLike,
  url: string,
  maxQueued = 200
): AgentTransport {
  let socket: WebSocketLike | undefined;
  let open = false;
  let closed = false;
  let helloMessage: string | undefined;
  let needsHello = false;
  let failures = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: string[] = [];

  const transport: AgentTransport = {
    hello(json: string): void {
      helloMessage = json;
      needsHello = true;
      enqueue(json);
    },
    send(json: string): void {
      enqueue(json);
    },
    close(): void {
      closed = true;
      clearReconnectTimer();
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    }
  };

  function clearReconnectTimer(): void {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  }

  /** Forget `ws` (it is broken or being replaced) and close it; its later events are ignored. */
  function dropSocket(ws: WebSocketLike): void {
    if (socket === ws) {
      socket = undefined;
    }
    open = false;
    if (helloMessage) {
      needsHello = true;
    }
    try {
      ws.close();
    } catch {
      /* already unusable */
    }
    transport.onStateChange?.(false);
  }

  function scheduleReconnect(): void {
    if (closed || socket || reconnectTimer !== undefined || queue.length === 0) {
      return;
    }
    if (failures === 0) {
      connect();
      return;
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(failures - 1, 10));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      if (!closed && !socket && queue.length > 0) {
        connect();
      }
    }, delay);
    // Never keep a Node process alive just to retry telemetry.
    (reconnectTimer as unknown as { unref?: () => void }).unref?.();
  }

  function enqueue(json: string): void {
    if (closed) {
      return;
    }
    if (open && socket) {
      try {
        socket.send(json);
        return;
      } catch {
        dropSocket(socket);
      }
    }
    if (queue.length >= maxQueued) {
      queue.shift();
    }
    queue.push(json);
    // While a backoff timer is pending the next attempt is already scheduled;
    // connecting here would turn every flush into a connection attempt.
    if (!socket && reconnectTimer === undefined) {
      connect();
    }
  }

  function connect(): void {
    if (socket || closed) {
      return;
    }
    const before = activeNodeHandleSnapshot();
    let ws: WebSocketLike;
    try {
      ws = new WebSocketCtor(url);
    } catch {
      open = false;
      failures++;
      scheduleReconnect();
      return;
    }
    socket = ws;
    let everOpened = false;

    ws.onopen = () => {
      if (socket !== ws) {
        return;
      }
      everOpened = true;
      failures = 0;
      open = true;
      transport.onStateChange?.(true);
      const pending = queue.splice(0, queue.length);
      if (needsHello && helloMessage && pending[0] !== helloMessage) {
        pending.unshift(helloMessage);
      }
      for (let index = 0; index < pending.length; index++) {
        const item = pending[index];
        try {
          ws.send(item);
          if (needsHello && item === helloMessage) {
            needsHello = false;
          }
        } catch {
          queue.unshift(...pending.slice(index));
          dropSocket(ws);
          scheduleReconnect();
          return;
        }
      }
      // Only unref once the handshake is done and everything queued while
      // connecting has been handed off. Unref-ing any earlier (e.g. right
      // after `new WebSocketCtor(...)`) would let a fast-finishing script
      // exit before the connection even opens, silently dropping every
      // event it produced — worse than the hang this is fixing. Once caught
      // up, later sends go straight to the (already unref'd) socket and
      // still reach the editor; they just no longer force the process to
      // wait around afterwards.
      unrefNewNodeHandles(before, url);
    };
    ws.onclose = () => {
      if (socket !== ws) {
        return; // a socket we already replaced; its late close must not touch the new one
      }
      open = false;
      socket = undefined;
      if (helloMessage) {
        needsHello = true;
      }
      if (!everOpened) {
        failures++;
      }
      transport.onStateChange?.(false);
      scheduleReconnect();
    };
    ws.onerror = () => {
      if (socket === ws) {
        open = false;
      }
    };
    ws.onmessage = (ev) => {
      if (socket === ws && typeof ev.data === 'string') {
        transport.onMessage?.(ev.data);
      }
    };
  }

  return transport;
}
