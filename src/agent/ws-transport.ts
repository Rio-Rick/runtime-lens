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
 * Shared WebSocket transport (browser + modern Node). Buffers up to 200
 * messages while the socket opens, then drains them in order.
 */
export function createGlobalWebSocketTransport(
  WebSocketCtor: new (url: string) => WebSocketLike,
  url: string,
  maxQueued = 200
): AgentTransport {
  let socket: WebSocketLike | undefined;
  let open = false;
  let closed = false;
  const queue: string[] = [];

  const transport: AgentTransport = {
    hello(json: string): void {
      connect();
      enqueue(json);
    },
    send(json: string): void {
      enqueue(json);
    },
    close(): void {
      closed = true;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    }
  };

  function enqueue(json: string): void {
    if (closed) {
      return;
    }
    if (open && socket) {
      try {
        socket.send(json);
        return;
      } catch {
        open = false;
      }
    }
    if (queue.length >= maxQueued) {
      queue.shift();
    }
    queue.push(json);
  }

  function connect(): void {
    if (socket || closed) {
      return;
    }
    try {
      socket = new WebSocketCtor(url);
    } catch {
      closed = true;
      return;
    }
    socket.onopen = () => {
      open = true;
      transport.onStateChange?.(true);
      const pending = queue.splice(0, queue.length);
      for (const item of pending) {
        try {
          socket?.send(item);
        } catch {
          break;
        }
      }
    };
    socket.onclose = () => {
      open = false;
      socket = undefined;
      transport.onStateChange?.(false);
    };
    socket.onerror = () => {
      open = false;
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        transport.onMessage?.(ev.data);
      }
    };
  }

  return transport;
}

