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

  it('only unrefs the newly-created socket that matches the WebSocket endpoint', () => {
    const originalGetActiveHandles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles;
    let snapshot = 0;
    let matchingUnrefs = 0;
    let unrelatedUnrefs = 0;
    const existing = { constructor: { name: 'Socket' }, remoteAddress: '127.0.0.1', remotePort: 4321 };
    const matching = {
      constructor: { name: 'Socket' },
      remoteAddress: '127.0.0.1',
      remotePort: 4321,
      unref: () => matchingUnrefs++
    };
    const unrelated = { constructor: { name: 'Timeout' }, unref: () => unrelatedUnrefs++ };
    (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles = () => {
      snapshot++;
      return snapshot === 1 ? [existing] : [existing, matching, unrelated];
    };
    try {
      const transport = createGlobalWebSocketTransport(FakeSocket, 'ws://127.0.0.1:4321/rl?token=t');
      transport.hello('{"t":"hello"}');
      FakeSocket.instances[0].open();
      assert.equal(matchingUnrefs, 1);
      assert.equal(unrelatedUnrefs, 0);
    } finally {
      (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles = originalGetActiveHandles;
    }
  });

  it('reconnects after a socket closes before the next send', () => {
    const transport = createGlobalWebSocketTransport(FakeSocket, 'ws://127.0.0.1:1/rl?token=t');
    transport.hello('{\"t\":\"hello-1\"}');
    const first = FakeSocket.instances[0];
    first.open();
    first.close();

    transport.send('{\"t\":\"event-after-reconnect\"}');
    assert.equal(FakeSocket.instances.length, 2);
    const second = FakeSocket.instances[1];
    second.open();
    assert.deepEqual(second.sent, ['{\"t\":\"hello-1\"}', '{\"t\":\"event-after-reconnect\"}']);
  });

  it('retains the unsent tail when the first socket send fails', () => {
    class FlakySocket extends FakeSocket {
      static shouldFail = true;
      send(data: string): void {
        if (FlakySocket.shouldFail && this.sent.length >= 1) {
          FlakySocket.shouldFail = false;
          throw new Error('socket send failed');
        }
        super.send(data);
      }
    }

    const transport = createGlobalWebSocketTransport(FlakySocket, 'ws://127.0.0.1:1/rl?token=t');
    transport.hello('{\"t\":\"hello\"}');
    transport.send('{\"t\":\"event-1\"}');
    transport.send('{\"t\":\"event-2\"}');
    const first = FlakySocket.instances[0];
    first.open();

    assert.equal(FlakySocket.instances.length, 2);
    const second = FlakySocket.instances[1];
    second.open();
    assert.deepEqual(second.sent, ['{\"t\":\"hello\"}', '{\"t\":\"event-1\"}', '{\"t\":\"event-2\"}']);
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
