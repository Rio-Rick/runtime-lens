import assert from 'node:assert/strict';
import { createGlobalWebSocketTransport, type WebSocketLike } from '../src/agent/ws-transport';

/** Minimal fake matching the subset of the WebSocket API ws-transport depends on. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  static instances: FakeSocket[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.(undefined);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(undefined);
  }
  deliver(data: unknown): void {
    this.onmessage?.({ data });
  }
}

describe('agent/ws-transport (inbound messages)', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  it('forwards a server-pushed message to transport.onMessage', () => {
    const transport = createGlobalWebSocketTransport(FakeSocket, 'ws://127.0.0.1:1/rl?token=t');
    const received: string[] = [];
    transport.onMessage = (json) => received.push(json);

    transport.hello('{"t":"hello"}');
    const socket = FakeSocket.instances[0];
    socket.open();

    socket.deliver('{"t":"config","v":"1.0.0","objectDepth":10}');
    assert.deepEqual(received, ['{"t":"config","v":"1.0.0","objectDepth":10}']);
  });

  it('ignores non-string frames and never throws when onMessage is unset', () => {
    const transport = createGlobalWebSocketTransport(FakeSocket, 'ws://127.0.0.1:1/rl?token=t');
    transport.hello('{"t":"hello"}');
    const socket = FakeSocket.instances[0];
    socket.open();

    assert.doesNotThrow(() => socket.deliver(new ArrayBuffer(4)), 'no onMessage handler registered yet');

    const received: string[] = [];
    transport.onMessage = (json) => received.push(json);
    socket.deliver(new ArrayBuffer(4));
    assert.deepEqual(received, [], 'binary frames are not forwarded as config JSON');
  });

  it('still delivers state changes alongside inbound messages', () => {
    const transport = createGlobalWebSocketTransport(FakeSocket, 'ws://127.0.0.1:1/rl?token=t');
    const states: boolean[] = [];
    transport.onStateChange = (connected) => states.push(connected);
    transport.hello('{"t":"hello"}');
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.deliver('{"t":"config","v":"1.0.0","objectDepth":10}');
    socket.close();
    assert.deepEqual(states, [true, false]);
  });
});
