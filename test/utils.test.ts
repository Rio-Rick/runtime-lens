import assert from 'node:assert/strict';
import { TypedEmitter } from '../src/utils/events';
import { RingBuffer } from '../src/utils/ring-buffer';
import { debounce, throttle } from '../src/utils/throttle';
import {
  EXCLUDED_DIR_SEGMENTS,
  INSTRUMENTABLE_EXTENSIONS,
  normalizePath,
  relativeToRoot,
  requiresJsxCapableRuntime,
  shouldInstrument
} from '../src/utils/paths';
import { EventStore, lineKey } from '../src/runtime/store';
import { serialize } from '../src/serialization/serializer';
import { previewArgs } from '../src/serialization/preview';
import type { RuntimeEvent } from '../src/protocol';

interface TestEvents {
  ping: { n: number };
  pong: { text: string };
}

describe('utils/events (TypedEmitter)', () => {
  it('delivers events to all listeners in registration order', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const seen: string[] = [];
    emitter.on('ping', (e) => seen.push(`a${e.n}`));
    emitter.on('ping', (e) => seen.push(`b${e.n}`));
    emitter.emit('ping', { n: 1 });
    assert.deepEqual(seen, ['a1', 'b1']);
  });

  it('supports once, unsubscription and listenerCount', () => {
    const emitter = new TypedEmitter<TestEvents>();
    let calls = 0;
    emitter.once('ping', () => calls++);
    const off = emitter.on('ping', () => calls++);
    assert.equal(emitter.listenerCount('ping'), 2);
    emitter.emit('ping', { n: 1 });
    assert.equal(calls, 2);
    assert.equal(emitter.listenerCount('ping'), 1, 'once listener removed itself');
    off.dispose();
    emitter.emit('ping', { n: 2 });
    assert.equal(calls, 2);
    assert.equal(emitter.listenerCount('ping'), 0);
  });

  it('isolates listener errors so one bad subscriber cannot break the rest', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const seen: string[] = [];
    emitter.on('ping', () => {
      throw new Error('listener blew up');
    });
    emitter.on('ping', () => seen.push('survivor'));
    assert.doesNotThrow(() => emitter.emit('ping', { n: 1 }));
    assert.deepEqual(seen, ['survivor']);
  });

  it('ignores emits with no listeners and clears on dispose', () => {
    const emitter = new TypedEmitter<TestEvents>();
    assert.doesNotThrow(() => emitter.emit('pong', { text: 'x' }));
    emitter.on('ping', () => undefined);
    emitter.on('pong', () => undefined);
    emitter.removeAll('ping');
    assert.equal(emitter.listenerCount('ping'), 0);
    assert.equal(emitter.listenerCount('pong'), 1);
    emitter.dispose();
    assert.equal(emitter.listenerCount('pong'), 0);
  });

  it('tolerates a listener that unsubscribes during emit', () => {
    const emitter = new TypedEmitter<TestEvents>();
    const seen: number[] = [];
    const off = emitter.on('ping', (e) => {
      seen.push(e.n);
      off.dispose();
    });
    emitter.on('ping', (e) => seen.push(e.n * 100));
    emitter.emit('ping', { n: 1 });
    emitter.emit('ping', { n: 2 });
    assert.deepEqual(seen, [1, 100, 200]);
  });
});

describe('utils/ring-buffer', () => {
  it('stores items up to capacity and then overwrites the oldest', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    assert.deepEqual(buffer.toArray(), [1, 2, 3]);
    assert.equal(buffer.size, 3);
    assert.equal(buffer.dropped, 0);

    buffer.push(4);
    assert.deepEqual(buffer.toArray(), [2, 3, 4]);
    assert.equal(buffer.size, 3);
    assert.equal(buffer.dropped, 1);
  });

  it('iterates newest-first via reversed()', () => {
    const buffer = new RingBuffer<number>(4);
    for (const n of [1, 2, 3, 4, 5]) {
      buffer.push(n);
    }
    assert.deepEqual([...buffer.reversed()], [5, 4, 3, 2]);
  });

  it('drains, clears and resizes without losing ordering', () => {
    const buffer = new RingBuffer<number>(5);
    for (const n of [1, 2, 3]) {
      buffer.push(n);
    }
    assert.deepEqual(buffer.drain(), [1, 2, 3]);
    assert.equal(buffer.size, 0);

    for (const n of [4, 5, 6, 7]) {
      buffer.push(n);
    }
    buffer.resize(2);
    assert.equal(buffer.capacity, 2);
    assert.deepEqual(buffer.toArray(), [6, 7], 'shrinking keeps the newest items');

    buffer.resize(4);
    buffer.push(8);
    assert.deepEqual(buffer.toArray(), [6, 7, 8]);

    buffer.clear();
    assert.equal(buffer.size, 0);
    assert.deepEqual(buffer.toArray(), []);
  });

  it('handles a capacity of one', () => {
    const buffer = new RingBuffer<string>(1);
    buffer.push('a');
    buffer.push('b');
    assert.deepEqual(buffer.toArray(), ['b']);
    assert.equal(buffer.dropped, 1);
  });
});

describe('utils/throttle', () => {
  it('runs at most once per window and flushes trailing calls', async () => {
    const calls: number[] = [];
    const throttled = throttle((n: number) => calls.push(n), 30);
    throttled(1);
    throttled(2);
    throttled(3);
    assert.deepEqual(calls, [1], 'the leading call runs immediately');
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(calls, [1, 3], 'only the last trailing call runs');
    throttled.cancel();
  });

  it('flush() runs a pending trailing call immediately', () => {
    const calls: string[] = [];
    const throttled = throttle((s: string) => calls.push(s), 1000);
    throttled('a');
    throttled('b');
    throttled.flush();
    assert.deepEqual(calls, ['a', 'b']);
    throttled.cancel();
  });

  it('cancel() drops the pending call', async () => {
    const calls: string[] = [];
    const throttled = throttle((s: string) => calls.push(s), 20);
    throttled('a');
    throttled('b');
    throttled.cancel();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(calls, ['a']);
  });

  it('debounce only runs after the quiet period', async () => {
    const calls: number[] = [];
    const debounced = debounce((n: number) => calls.push(n), 25);
    debounced(1);
    debounced(2);
    debounced(3);
    assert.deepEqual(calls, []);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(calls, [3]);
  });
});

describe('utils/paths', () => {
  it('exposes the excluded directory list and instrumentable extensions', () => {
    for (const segment of ['node_modules', '.next', 'dist', 'build', 'out', '.git']) {
      assert.ok(EXCLUDED_DIR_SEGMENTS.includes(segment), `${segment} must be excluded`);
    }
    for (const ext of ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']) {
      assert.ok(INSTRUMENTABLE_EXTENSIONS.includes(ext), ext);
    }
  });

  it('shouldInstrument accepts source files and rejects generated ones', () => {
    assert.equal(shouldInstrument('/p/src/app.ts'), true);
    assert.equal(shouldInstrument('/p/src/App.tsx'), true);
    assert.equal(shouldInstrument('/p/src/legacy.jsx'), true);
    assert.equal(shouldInstrument('/p/scripts/tool.mjs'), true);
    assert.equal(shouldInstrument('/p/node_modules/react/index.js'), false);
    assert.equal(shouldInstrument('/p/app/node_modules/x/y.js'), false);
    assert.equal(shouldInstrument('/p/.next/static/chunk.js'), false);
    assert.equal(shouldInstrument('/p/dist/main.js'), false);
    assert.equal(shouldInstrument('/p/build/index.js'), false);
    assert.equal(shouldInstrument('/p/coverage/lcov-report/x.js'), false);
    assert.equal(shouldInstrument('/p/src/types.d.ts'), false);
    assert.equal(shouldInstrument('/p/src/lib.min.js'), false);
    assert.equal(shouldInstrument('/p/src/style.css'), false);
    assert.equal(shouldInstrument('/p/README.md'), false);
    assert.equal(shouldInstrument(''), false);
    assert.equal(shouldInstrument('\0virtual:runtime-lens-agent'), false);
    assert.equal(shouldInstrument('/p/src/app.ts?v=123'), true, 'bundler query suffixes are tolerated');
  });

  it('treats windows-style paths the same way', () => {
    assert.equal(shouldInstrument('C:\\proj\\src\\a.ts'), true);
    assert.equal(shouldInstrument('C:\\proj\\node_modules\\pkg\\a.js'), false);
    assert.equal(normalizePath('C:\\proj\\src\\a.ts'), 'C:/proj/src/a.ts');
  });

  it('flags files that need a JSX-capable runtime', () => {
    assert.equal(requiresJsxCapableRuntime('/p/a.tsx'), true);
    assert.equal(requiresJsxCapableRuntime('/p/a.jsx'), true);
    assert.equal(requiresJsxCapableRuntime('/p/a.ts'), false);
    assert.equal(requiresJsxCapableRuntime('/p/a.js'), false);
  });

  it('relativeToRoot produces stable workspace-relative ids', () => {
    assert.equal(relativeToRoot('/p', '/p/src/a.ts'), 'src/a.ts');
    assert.equal(relativeToRoot('/other', '/p/src/a.ts'), '/p/src/a.ts', 'outside the root, keep the absolute path');
    assert.equal(relativeToRoot('/p', '/p/deep/nested/b.tsx'), 'deep/nested/b.tsx');
  });
});

describe('runtime/store', () => {
  const render = (event: RuntimeEvent): string =>
    event.t === 'log' ? previewArgs(event.args) : event.t === 'expr' ? event.expr : event.message;

  function logEvent(id: string, line: number, count = 1, level: 'log' | 'warn' | 'error' = 'log', text = 'hello'): RuntimeEvent {
    return {
      t: 'log',
      id,
      seq: line,
      ts: Date.now(),
      count,
      level,
      loc: { file: '/p/a.ts', line, column: 0 },
      args: [serialize(text)]
    };
  }

  function add(store: EventStore, event: RuntimeEvent, file = '/p/a.ts'): void {
    store.add([{ event, sessionId: 's1', loc: { ...event.loc, file }, remapped: false }]);
  }

  it('indexes the latest event per line and the count per probe', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('p1', 3, 1, 'log', 'first'));
    add(store, logEvent('p1', 3, 2, 'log', 'second'));
    add(store, logEvent('p2', 9));
    assert.equal(store.latestAt('/p/a.ts', 3)?.event.count, 2);
    assert.match(render(store.latestAt('/p/a.ts', 3)!.event), /second/);
    assert.equal(store.countFor('p1'), 2);
    assert.equal(store.countFor('p2'), 1);
    assert.equal(store.countFor('unknown'), 0);
    assert.equal(store.forFile('/p/a.ts').length, 2);
    assert.deepEqual(store.forFile('/p/a.ts').map((e) => e.loc.line), [3, 9]);
    assert.equal(store.forFile('/p/other.ts').length, 0);
  });

  it('lists newest-first and honours the history bound', () => {
    const store = new EventStore(50, render);
    for (let i = 1; i <= 120; i++) {
      add(store, logEvent(`p${i}`, i));
    }
    const list = store.list();
    assert.equal(list.length, 50, 'capacity is clamped to the configured history');
    assert.equal(list[0].loc.line, 120, 'newest first');
    assert.equal(store.stats().totalAdded, 120);
    assert.ok(store.stats().dropped >= 70);
    assert.equal(store.list(5).length, 5, 'limit is respected');
  });

  it('filters by query, level, kind and file', () => {
    const store = new EventStore(100, render);
    add(store, logEvent('a', 1, 1, 'log', 'apple pie'));
    add(store, logEvent('b', 2, 1, 'warn', 'banana bread'));
    add(store, logEvent('c', 3, 1, 'error', 'cherry cake'));
    store.add([
      {
        event: { t: 'expr', id: 'd', seq: 4, ts: Date.now(), count: 1, expr: 'total', loc: { file: '/p/b.ts', line: 4, column: 0 }, value: serialize(42) },
        sessionId: 's1',
        loc: { file: '/p/b.ts', line: 4, column: 0 },
        remapped: false
      }
    ]);

    store.setFilter({ query: 'banana' });
    assert.equal(store.list().length, 1);

    store.setFilter({ query: '', levels: new Set(['error']) });
    assert.deepEqual(
      store.list().map((e) => (e.event as { level?: string }).level),
      ['error'],
      'a level filter hides level-less expression probes'
    );

    store.setFilter({ levels: undefined, kinds: new Set(['expr']) });
    assert.deepEqual(store.list().map((e) => e.event.t), ['expr']);

    store.setFilter({ kinds: undefined, file: '/p/b.ts' });
    assert.deepEqual(store.list().map((e) => e.loc.file), ['/p/b.ts']);

    store.setFilter({ file: undefined, query: 'CHERRY' });
    assert.equal(store.list().length, 1, 'query matching is case-insensitive');
  });

  it('emits added, cleared and filter-changed', () => {
    const store = new EventStore(10, render);
    const seen: string[] = [];
    store.emitter.on('added', (e) => seen.push(`added:${e.events.length}`));
    store.emitter.on('cleared', () => seen.push('cleared'));
    store.emitter.on('filter-changed', (e) => seen.push(`filter:${e.filter.query}`));
    add(store, logEvent('a', 1));
    store.setFilter({ query: 'x' });
    store.clear();
    assert.deepEqual(seen, ['added:1', 'filter:x', 'cleared']);
    assert.equal(store.list().length, 0);
    assert.equal(store.latestAt('/p/a.ts', 1), undefined);
    assert.equal(store.countFor('a'), 0);
  });

  it('does not emit for an empty add', () => {
    const store = new EventStore(10, render);
    let calls = 0;
    store.emitter.on('added', () => calls++);
    store.add([]);
    assert.equal(calls, 0);
  });

  it('resizes history at runtime', () => {
    const store = new EventStore(1000, render);
    for (let i = 1; i <= 10; i++) {
      add(store, logEvent(`p${i}`, i));
    }
    store.setMaxHistory(5);
    assert.equal(store.stats().capacity, 50, 'a floor keeps the UI usable');
    store.setMaxHistory(200);
    assert.equal(store.stats().capacity, 200);
    assert.equal(store.list().length, 10, 'existing events survive a resize');
  });

  it('lineKey is file+line and normalises separators', () => {
    assert.equal(lineKey('/p/a.ts', 4), '/p/a.ts:4');
    assert.equal(lineKey('C:\\p\\a.ts', 4), 'C:/p/a.ts:4');
  });
});
