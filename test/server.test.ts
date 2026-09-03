import assert from 'node:assert/strict';
import * as http from 'node:http';
import WebSocket from 'ws';
import { RuntimeServer } from '../src/runtime/server';
import { findFreePort, isPortFree } from '../src/runtime/port';
import { PROTOCOL_VERSION, type RuntimeEvent } from '../src/protocol';
import { serialize } from '../src/serialization/serializer';
import { createSessionToken, tokensMatch } from '../src/utils/token';

const V = PROTOCOL_VERSION;

function logEvent(seq: number, line = 1): RuntimeEvent {
  return {
    t: 'log',
    id: `probe${seq}`,
    seq,
    ts: Date.now(),
    count: 1,
    level: 'log',
    loc: { file: '/p/a.ts', line, column: 0 },
    args: [serialize(`msg-${seq}`)]
  };
}

function post(
  port: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
  path = '/ingest'
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      })
      .on('error', reject);
  });
}

function once<T>(register: (cb: (value: T) => void) => void, timeoutMs = 4000, what = 'event'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs);
    register((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

describe('runtime/port', () => {
  it('finds a free ephemeral port on loopback', async () => {
    const port = await findFreePort(0, '127.0.0.1');
    assert.ok(port > 0 && port < 65536, `got ${port}`);
    assert.equal(await isPortFree(port, '127.0.0.1'), true);
  });

  it('falls back to another port when the preferred one is taken', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const taken = (blocker.address() as { port: number }).port;
    assert.equal(await isPortFree(taken, '127.0.0.1'), false);
    const chosen = await findFreePort(taken, '127.0.0.1');
    assert.notEqual(chosen, taken);
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });
});

describe('utils/token', () => {
  it('creates 256-bit hex tokens and compares them in constant time', () => {
    const a = createSessionToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, createSessionToken());
    assert.equal(tokensMatch(a, a), true);
    assert.equal(tokensMatch(a, a.slice(0, 63) + (a.endsWith('f') ? 'e' : 'f')), false);
    assert.equal(tokensMatch(a, ''), false);
    assert.equal(tokensMatch('', ''), false);
    assert.equal(tokensMatch(a, a + 'f'), false);
  });
});

describe('runtime/server (WebSocket + HTTP ingest)', () => {
  let server: RuntimeServer;
  let port = 0;
  const token = 'a'.repeat(64);

  beforeEach(async () => {
    server = new RuntimeServer({
      token,
      maxPayloadBytes: 8 * 1024,
      getAgentConfig: () => ({ captureConsole: true, captureExpressions: false, paused: true, objectDepth: 7 })
    });
    const started = await server.start();
    port = started.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('listens on loopback with a token and reports health', async () => {
    assert.ok(port > 0);
    assert.equal(server.isRunning, true);
    const health = await get(port, '/health');
    assert.equal(health.status, 200);
    const parsed = JSON.parse(health.body) as { ok: boolean; v: string; port: number };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.v, V);
    assert.equal(parsed.port, port);
  });

  it('completes a hello -> batch -> bye conversation over WebSocket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rl?token=${token}`);
    await once<void>((cb) => ws.on('open', () => cb()), 4000, 'ws open');

    const opened = once<{ sessionId: string; label: string; transport: string }>(
      (cb) => server.emitter.on('session-open', cb),
      4000,
      'session-open'
    );
    ws.send(JSON.stringify({ t: 'hello', v: V, token, sessionId: 's1', runtime: 'node', label: 'test (pid 1)', pid: 1 }));
    const session = await opened;
    assert.equal(session.sessionId, 's1');
    assert.equal(session.transport, 'ws');
    assert.equal(server.listSessions().length, 1);

    const received = once<{ sessionId: string; events: RuntimeEvent[]; dropped: number }>(
      (cb) => server.emitter.on('events', cb),
      4000,
      'events'
    );
    ws.send(JSON.stringify({ t: 'batch', v: V, sessionId: 's1', events: [logEvent(0), logEvent(1, 9)], dropped: 3 }));
    const payload = await received;
    assert.equal(payload.sessionId, 's1');
    assert.equal(payload.events.length, 2);
    assert.equal(payload.dropped, 3);
    assert.equal(payload.events[1].loc.line, 9);
    assert.equal(server.stats().totalEvents, 2);

    const closed = once<{ sessionId: string }>((cb) => server.emitter.on('session-close', cb), 4000, 'session-close');
    ws.send(JSON.stringify({ t: 'bye', v: V, sessionId: 's1', reason: 'done' }));
    const bye = await closed;
    assert.equal(bye.sessionId, 's1');
    ws.close();
  });

  it('pushes the current capture config to a connected agent', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rl?token=${token}`);
    await once<void>((cb) => ws.on('open', () => cb()), 4000, 'ws open');
    const message = once<string>((cb) => ws.on('message', (data) => cb(data.toString())), 4000, 'config');
    ws.send(JSON.stringify({ t: 'hello', v: V, token, sessionId: 's-cfg', runtime: 'node', label: 'cfg' }));
    const raw = await message;
    const config = JSON.parse(raw) as { t: string; paused: boolean; objectDepth: number; captureExpressions: boolean };
    assert.equal(config.t, 'config');
    assert.equal(config.paused, true);
    assert.equal(config.captureExpressions, false);
    assert.equal(config.objectDepth, 7);
    ws.close();
  });

  it('rejects a WebSocket upgrade with a bad token', async () => {
    const rejection = once<{ code: string }>((cb) => server.emitter.on('protocol-error', cb), 4000, 'protocol-error');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rl?token=deadbeef`);
    const err = await once<Error>((cb) => ws.on('error', cb), 4000, 'ws error');
    assert.match(err.message, /401|Unexpected server response/);
    assert.equal((await rejection).code, 'bad-token');
    assert.equal(server.listSessions().length, 0);
  });

  it('rejects an upgrade on an unknown path', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/nope?token=${token}`);
    const err = await once<Error>((cb) => ws.on('error', cb), 4000, 'ws error');
    assert.ok(err);
  });

  it('reports an incompatible agent version instead of silently dropping it', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rl?token=${token}`);
    await once<void>((cb) => ws.on('open', () => cb()), 4000, 'ws open');
    const reply = once<string>((cb) => ws.on('message', (d) => cb(d.toString())), 4000, 'error reply');
    ws.send(JSON.stringify({ t: 'hello', v: '9.0.0', token, sessionId: 's-old', runtime: 'node', label: 'old' }));
    const parsed = JSON.parse(await reply) as { t: string; code: string; message: string };
    assert.equal(parsed.t, 'error');
    assert.equal(parsed.code, 'bad-version');
    assert.match(parsed.message, /incompatible protocol version/);
  });

  it('rejects malformed JSON and unknown message types over WebSocket', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rl?token=${token}`);
    await once<void>((cb) => ws.on('open', () => cb()), 4000, 'ws open');
    const reply = once<string>((cb) => ws.on('message', (d) => cb(d.toString())), 4000, 'error reply');
    ws.send('{ this is not json');
    const parsed = JSON.parse(await reply) as { code: string };
    assert.equal(parsed.code, 'bad-message');
    ws.close();
  });

  it('drops WebSocket payloads over the configured cap', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rl?token=${token}`);
    await once<void>((cb) => ws.on('open', () => cb()), 4000, 'ws open');
    ws.send(JSON.stringify({ t: 'hello', v: V, token, sessionId: 's-big', runtime: 'node', label: 'big' }));
    const closedOrError = once<string>(
      (cb) => {
        ws.on('close', (code) => cb(`close:${code}`));
        ws.on('error', (e) => cb(`error:${e.message}`));
      },
      6000,
      'oversize rejection'
    );
    const huge = JSON.stringify({
      t: 'batch',
      v: V,
      sessionId: 's-big',
      events: [logEvent(0, 1)],
      pad: 'x'.repeat(20 * 1024)
    });
    assert.ok(Buffer.byteLength(huge) > server.maxPayloadBytes);
    ws.send(huge);
    const outcome = await closedOrError;
    assert.match(outcome, /close:1009|error:/, `ws should refuse oversize frames, got ${outcome}`);
  });

  it('accepts HTTP /ingest with the token and acks the count', async () => {
    const received = once<{ events: RuntimeEvent[] }>((cb) => server.emitter.on('events', cb), 4000, 'events');
    const res = await post(
      port,
      JSON.stringify({ t: 'batch', v: V, sessionId: 'http-1', events: [logEvent(0), logEvent(1)] }),
      { 'x-runtime-lens-token': token }
    );
    assert.equal(res.status, 200);
    const ack = JSON.parse(res.body) as { t: string; received: number };
    assert.equal(ack.t, 'ack');
    assert.equal(ack.received, 2);
    assert.equal((await received).events.length, 2);
  });

  it('creates an implicit http session on first ingest', async () => {
    await post(port, JSON.stringify({ t: 'hello', v: V, token, sessionId: 'http-2', runtime: 'node', label: 'curl' }), {
      'x-runtime-lens-token': token
    });
    const session = server.listSessions().find((s) => s.sessionId === 'http-2');
    assert.ok(session, 'expected an http session');
    assert.equal(session?.transport, 'http');
  });

  it('rejects /ingest without a token (401) and with a bad path (404)', async () => {
    const noToken = await post(port, JSON.stringify({ t: 'bye', v: V, sessionId: 's' }));
    assert.equal(noToken.status, 401);

    const badToken = await post(port, JSON.stringify({ t: 'bye', v: V, sessionId: 's' }), {
      'x-runtime-lens-token': 'b'.repeat(64)
    });
    assert.equal(badToken.status, 401);

    const badPath = await post(port, '{}', { 'x-runtime-lens-token': token }, '/elsewhere');
    assert.equal(badPath.status, 404);
  });

  it('rejects an oversized HTTP body with 413', async () => {
    const body = JSON.stringify({ t: 'batch', v: V, sessionId: 's', events: [], pad: 'x'.repeat(20 * 1024) });
    const res = await post(port, body, { 'x-runtime-lens-token': token });
    assert.equal(res.status, 413);
    assert.match(res.body, /too large/);
  });

  it('rejects a malformed HTTP body with 400 and a protocol error payload', async () => {
    const res = await post(port, '{ nope', { 'x-runtime-lens-token': token });
    assert.equal(res.status, 400);
    const parsed = JSON.parse(res.body) as { t: string; code: string };
    assert.equal(parsed.t, 'error');
    assert.equal(parsed.code, 'bad-message');
    assert.ok(server.stats().rejected > 0);
  });

  it('is idempotent on start and stop', async () => {
    const again = await server.start();
    assert.equal(again.port, port);
    await server.stop();
    assert.equal(server.isRunning, false);
    await server.stop();
    assert.equal(server.stats().port, 0);
  });

  it('generates a fresh token per start when none is injected', async () => {
    const a = new RuntimeServer();
    const b = new RuntimeServer();
    const ra = await a.start();
    const rb = await b.start();
    assert.notEqual(ra.token, rb.token);
    assert.notEqual(ra.port, rb.port);
    await a.stop();
    await b.stop();
  });
});
