import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, type RuntimeEvent } from '../src/protocol';
import { EventStore } from '../src/runtime/store';
import { previewArgs } from '../src/serialization/preview';
import { serialize } from '../src/serialization/serializer';
import { buildExportPayload, defaultExportFileName, exportPayloadToJson } from '../src/vscode/export-log';

const render = (event: RuntimeEvent): string =>
  event.t === 'log' ? previewArgs(event.args) : event.t === 'expr' ? event.expr : event.message;

function logEvent(id: string, line: number, level: 'log' | 'warn' | 'error' = 'log', text = 'hello', count = 1): RuntimeEvent {
  return {
    t: 'log',
    id,
    seq: line,
    ts: Date.parse('2026-09-22T10:00:00.000Z') + line * 1000,
    count,
    level,
    loc: { file: '/p/a.ts', line, column: 2 },
    args: [serialize(text)]
  };
}

function exprEvent(id: string, line: number, expr: string, value: unknown): RuntimeEvent {
  return {
    t: 'expr',
    id,
    seq: line,
    ts: Date.parse('2026-09-22T10:00:00.000Z') + line * 1000,
    count: 1,
    expr,
    loc: { file: '/p/b.ts', line, column: 4 },
    value: serialize(value)
  };
}

function add(store: EventStore, event: RuntimeEvent, sessionId = 's1'): void {
  store.add([{ event, sessionId, loc: { ...event.loc }, remapped: event.loc.file.endsWith('b.ts') }]);
}

describe('vscode/export-log', () => {
  it('orders events oldest-first even though the store lists newest-first', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('p1', 1, 'log', 'first'));
    add(store, logEvent('p2', 2, 'log', 'second'));
    add(store, logEvent('p3', 3, 'log', 'third'));

    const payload = buildExportPayload(store.list());
    assert.deepEqual(
      payload.events.map((e) => e.text),
      ['first', 'second', 'third']
    );
  });

  it('captures the essential fields for a log event', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('p1', 5, 'warn', 'low stock', 3));

    const payload = buildExportPayload(store.list());
    assert.equal(payload.totalEvents, 1);
    const [event] = payload.events;
    assert.equal(event.kind, 'log');
    assert.equal(event.level, 'warn');
    assert.equal(event.text, 'low stock');
    assert.equal(event.file, '/p/a.ts');
    assert.equal(event.line, 5);
    assert.equal(event.column, 2);
    assert.equal(event.count, 3);
    assert.equal(event.sessionId, 's1');
    assert.equal(event.remapped, false);
    assert.equal(event.timestamp, new Date(Date.parse('2026-09-22T10:00:00.000Z') + 5000).toISOString());
  });

  it('leaves level undefined for expression probes and errors', () => {
    const store = new EventStore(100, render);
    add(store, exprEvent('p1', 1, 'total', 42));
    const payload = buildExportPayload(store.list());
    assert.equal(payload.events[0].kind, 'expr');
    assert.equal(payload.events[0].level, undefined);
    assert.match(payload.events[0].text, /42/);
  });

  it('stamps generatedAt and protocolVersion, and uses the real clock by default', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('p1', 1));
    const fixed = new Date('2026-01-02T03:04:05.000Z');
    const withFixedClock = buildExportPayload(store.list(), { now: () => fixed });
    assert.equal(withFixedClock.generatedAt, fixed.toISOString());
    assert.equal(withFixedClock.protocolVersion, PROTOCOL_VERSION);
    assert.equal(withFixedClock.tool, 'runtime-lens');

    const withRealClock = buildExportPayload(store.list());
    assert.ok(Math.abs(Date.now() - Date.parse(withRealClock.generatedAt)) < 5000);
  });

  it('omits the filter field entirely when no filter is active', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('p1', 1));
    const payload = buildExportPayload(store.list(), { filter: store.filter });
    assert.equal(payload.filter, undefined);
  });

  it('summarizes an active filter (query, levels, file) when present', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('p1', 1, 'warn', 'low stock'));
    store.setFilter({ query: 'stock', levels: new Set(['warn']), file: '/p/a.ts' });

    const payload = buildExportPayload(store.list(), { filter: store.filter });
    assert.ok(payload.filter);
    assert.equal(payload.filter?.query, 'stock');
    assert.deepEqual(payload.filter?.levels, ['warn']);
    assert.equal(payload.filter?.file, '/p/a.ts');
  });

  it('only exports events currently matching the store\'s active filter', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('p1', 1, 'log', 'apple'));
    add(store, logEvent('p2', 2, 'warn', 'banana'));
    store.setFilter({ query: 'banana' });

    const payload = buildExportPayload(store.list(), { filter: store.filter });
    assert.equal(payload.totalEvents, 1);
    assert.equal(payload.events[0].text, 'banana');
  });

  it('produces pretty, trailing-newline-terminated JSON that round-trips', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('p1', 1, 'log', 'hello'));
    const payload = buildExportPayload(store.list());
    const json = exportPayloadToJson(payload);

    assert.ok(json.endsWith('\n'));
    assert.ok(json.includes('\n  '), 'expected indented (pretty-printed) JSON');
    // `filter` is `undefined` (present but empty) rather than absent on the
    // payload object itself, and JSON has no way to represent that; round
    // this comparison through JSON on both sides so that distinction (which
    // `deepEqual` cares about but JSON readers never see) doesn't matter.
    assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(payload)));
  });

  it('handles an empty event list', () => {
    const payload = buildExportPayload([]);
    assert.equal(payload.totalEvents, 0);
    assert.deepEqual(payload.events, []);
  });

  it('builds a sortable, filesystem-safe default file name from a fixed clock', () => {
    const name = defaultExportFileName(new Date('2026-09-22T14:05:30.123Z'));
    assert.equal(name, 'runtime-lens-log-2026-09-22T14-05-30-123Z.json');
    assert.doesNotMatch(name, /[:*?"<>|]/, 'must be safe on Windows filesystems too');
  });
});
