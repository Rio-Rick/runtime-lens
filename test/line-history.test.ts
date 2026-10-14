import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { EventStore, TRAIL_SIZE, numericValueOf } from '../src/runtime/store';
import { serialize } from '../src/serialization/serializer';
import { previewArgs } from '../src/serialization/preview';
import {
  collapseHistory,
  formatNumber,
  hoverExtras,
  hoverMarkdown,
  inlineExtras,
  inlineText,
  SHOW_PROBE_HISTORY_COMMAND,
  sparkline,
  statsText,
  type RenderConfig
} from '../src/vscode/render';
import type { RuntimeEvent } from '../src/protocol';
import { parseHostMessage, parseWebviewMessage } from '../src/webview/messages';
import { initialState, reduce } from '../src/webview/view-state';

const render = (e: RuntimeEvent): string => (e.t === 'log' ? previewArgs(e.args) : '');

const CONFIG: RenderConfig = {
  maxInlineLength: 120,
  showTimestamp: false,
  showExecutionCount: true,
  objectDepth: 3,
  showPreviousValue: true,
  showValueStats: true,
  hoverHistory: 10
};

function logOf(id: string, count: number, ...values: unknown[]): RuntimeEvent {
  return {
    t: 'log',
    id,
    seq: count,
    ts: 1_700_000_000_000 + count,
    count,
    level: 'log',
    loc: { file: '/p/a.ts', line: 5, column: 0 },
    args: values.map((v) => serialize(v))
  };
}

function exprOf(id: string, count: number, value: unknown): RuntimeEvent {
  return {
    t: 'expr',
    id,
    seq: count,
    ts: 1_700_000_000_000 + count,
    count,
    expr: 'total',
    loc: { file: '/p/a.ts', line: 5, column: 0 },
    value: serialize(value)
  };
}

function add(store: EventStore, event: RuntimeEvent): void {
  store.add([{ event, sessionId: 's', loc: event.loc, remapped: false }]);
}

describe('runtime/store: per-probe history and numeric stats', () => {
  it('historyOf returns the newest runs first and honours the limit', () => {
    const store = new EventStore(1000, render);
    for (let i = 1; i <= 30; i++) {
      add(store, logOf('p1', i, i * 10));
    }
    const recent = store.historyOf('p1', 5);
    assert.deepEqual(recent.map((s) => s.event.count), [30, 29, 28, 27, 26]);
    assert.equal(store.historyOf('p1', 100).length, 30);
    assert.deepEqual(store.historyOf('p1', 0), []);
    assert.deepEqual(store.historyOf('nope', 5), []);
  });

  it('keeps probes that share a line apart', () => {
    const store = new EventStore(1000, render);
    add(store, logOf('a', 1, 'A1'));
    add(store, logOf('b', 1, 'B1'));
    add(store, logOf('a', 2, 'A2'));
    assert.deepEqual(store.historyOf('a', 5).map((s) => s.event.count), [2, 1]);
    assert.deepEqual(store.historyOf('b', 5).map((s) => s.event.count), [1]);
  });

  it('previousOf finds the run before, and nothing for the first run', () => {
    const store = new EventStore(1000, render);
    add(store, logOf('p', 1, 10));
    add(store, logOf('p', 2, 20));
    add(store, logOf('p', 3, 30));
    const [latest, middle, first] = store.historyOf('p', 3);
    assert.equal(store.previousOf(latest)?.event.count, 2);
    assert.equal(store.previousOf(middle)?.event.count, 1);
    assert.equal(store.previousOf(first), undefined);
  });

  it('history follows ring-buffer eviction, never returning dropped events', () => {
    const store = new EventStore(50, render); // min capacity is 50
    for (let i = 1; i <= 80; i++) {
      add(store, logOf('p', i, i));
    }
    const all = store.historyOf('p', 1000);
    assert.equal(all.length, 50);
    assert.equal(all[0].event.count, 80);
    assert.equal(all[all.length - 1].event.count, 31);
  });

  it('tracks min/max/avg/trail incrementally and survives eviction and resize', () => {
    const store = new EventStore(50, render);
    for (let i = 1; i <= 200; i++) {
      add(store, logOf('p', i, i));
    }
    const stats = store.statsOf('p')!;
    // History kept only the last 50 events, but the stats cover all 200.
    assert.equal(stats.numeric, 200);
    assert.equal(stats.min, 1);
    assert.equal(stats.max, 200);
    assert.equal(stats.avg, 100.5);
    assert.deepEqual(stats.trail(), [193, 194, 195, 196, 197, 198, 199, 200]);
    assert.equal(stats.trail().length, TRAIL_SIZE);

    store.setMaxHistory(100); // rebuilds history indexes; must not recount stats
    assert.equal(store.statsOf('p')!.numeric, 200);
  });

  it('only counts a single finite number: strings, objects, NaN and multi-arg logs are ignored', () => {
    const store = new EventStore(1000, render);
    add(store, logOf('p', 1, 5));
    add(store, logOf('p', 2, 'text'));
    add(store, logOf('p', 3, { a: 1 }));
    add(store, logOf('p', 4, Number.NaN));
    add(store, logOf('p', 5, Infinity));
    add(store, logOf('p', 6, 1, 2));
    add(store, logOf('p', 7, 9));
    const stats = store.statsOf('p')!;
    assert.equal(stats.numeric, 2);
    assert.equal(stats.min, 5);
    assert.equal(stats.max, 9);
    assert.equal(store.statsOf('never-numeric'), undefined);
    add(store, logOf('words', 1, 'hello'));
    assert.equal(store.statsOf('words'), undefined);
  });

  it('reads expression probes too', () => {
    const store = new EventStore(1000, render);
    add(store, exprOf('e', 1, 2.5));
    add(store, exprOf('e', 2, 7.5));
    assert.equal(numericValueOf(exprOf('e', 3, 4)), 4);
    assert.equal(store.statsOf('e')!.sum, 10);
  });

  it('Clear resets history and stats', () => {
    const store = new EventStore(1000, render);
    add(store, logOf('p', 1, 1));
    add(store, logOf('p', 2, 2));
    store.clear();
    assert.deepEqual(store.historyOf('p', 5), []);
    assert.equal(store.statsOf('p'), undefined);
    add(store, logOf('p', 1, 100));
    assert.equal(store.statsOf('p')!.min, 100);
  });
});

describe('vscode/render: inline previous value and stats', () => {
  it('stays exactly as before when no extras are passed', () => {
    assert.equal(inlineText(logOf('p', 3, 120), CONFIG), '// => 120 × 3');
    assert.equal(inlineText(logOf('p', 1, 120), CONFIG), '// => 120');
  });

  it('shows (was X) only when the value changed on a repeat run', () => {
    const changed = inlineText(logOf('p', 2, 120), CONFIG, { previous: logOf('p', 1, 118) });
    assert.equal(changed, '// => 120 × 2 (was 118)');
    const same = inlineText(logOf('p', 2, 120), CONFIG, { previous: logOf('p', 1, 120) });
    assert.equal(same, '// => 120 × 2');
    const first = inlineText(logOf('p', 1, 120), CONFIG, { previous: logOf('p', 0, 1) });
    assert.equal(first, '// => 120', 'a first run has no "was"');
    const off = inlineText(logOf('p', 2, 120), { ...CONFIG, showPreviousValue: false }, { previous: logOf('p', 1, 118) });
    assert.equal(off, '// => 120 × 2');
  });

  it('shortens a long previous value so it cannot crowd the line', () => {
    const long = 'x'.repeat(200);
    const text = inlineText(logOf('p', 2, 'new'), CONFIG, { previous: logOf('p', 1, long) });
    assert.match(text, /\(was x{23}…\)$/);
  });

  it('adds min/max/sparkline for numeric probes, and stays quiet for flat or tiny samples', () => {
    const store = new EventStore(1000, render);
    for (const [i, v] of [3, 8, 5, 120].entries()) {
      add(store, logOf('p', i + 1, v));
    }
    const latest = store.latestAt('/p/a.ts', 5)!;
    const text = inlineText(latest.event, CONFIG, inlineExtras(store, latest, CONFIG));
    assert.match(text, /^\/\/ => 120 × 4 \(was 5\) · min 3 · max 120 [▁-█]{4}$/);

    const flat = new EventStore(1000, render);
    for (let i = 1; i <= 5; i++) {
      add(flat, logOf('f', i, 7));
    }
    const flatLatest = flat.latestAt('/p/a.ts', 5)!;
    assert.equal(inlineText(flatLatest.event, CONFIG, inlineExtras(flat, flatLatest, CONFIG)), '// => 7 × 5');

    const tiny = new EventStore(1000, render);
    add(tiny, logOf('t', 1, 1));
    add(tiny, logOf('t', 2, 9));
    const tinyLatest = tiny.latestAt('/p/a.ts', 5)!;
    assert.doesNotMatch(inlineText(tinyLatest.event, CONFIG, inlineExtras(tiny, tinyLatest, CONFIG)), /min/);
  });

  it('does not show numeric stats next to a non-numeric current value', () => {
    const store = new EventStore(1000, render);
    for (const v of [1, 2, 3, 4]) {
      add(store, logOf('p', v, v));
    }
    add(store, logOf('p', 5, 'oops'));
    const latest = store.latestAt('/p/a.ts', 5)!;
    const text = inlineText(latest.event, CONFIG, inlineExtras(store, latest, CONFIG));
    assert.doesNotMatch(text, /min/);
    assert.match(text, /\(was 4\)/);
  });

  it('inlineExtras does no work when both features are off', () => {
    const store = new EventStore(1000, render);
    add(store, logOf('p', 1, 1));
    const latest = store.latestAt('/p/a.ts', 5)!;
    assert.equal(inlineExtras(store, latest, { ...CONFIG, showPreviousValue: false, showValueStats: false }), undefined);
  });

  it('sparkline / formatNumber / statsText behave on edge cases', () => {
    assert.equal(sparkline([]), '');
    assert.equal(sparkline([1, 1, 1]), '▄▄▄');
    assert.equal(sparkline([0, 7]), '▁█');
    assert.equal(formatNumber(3), '3');
    assert.equal(formatNumber(3.14159265), '3.142');
    assert.equal(formatNumber(0.1 + 0.2), '0.3');
    const store = new EventStore(1000, render);
    add(store, logOf('p', 1, 1));
    assert.equal(statsText(store.statsOf('p')!), undefined);
  });
});

describe('vscode/render: hover history', () => {
  it('collapses consecutive identical values into one row with a run range', () => {
    const store = new EventStore(1000, render);
    for (const [i, v] of [1, 2, 2, 2, 3].entries()) {
      add(store, logOf('p', i + 1, v));
    }
    const rows = collapseHistory(store.historyOf('p', 10));
    assert.deepEqual(
      rows.map((r) => [r.fromRun, r.toRun, r.text]),
      [
        [5, 5, '3'],
        [2, 4, '2'],
        [1, 1, '1']
      ]
    );
  });

  it('renders a History and a Numeric section, newest first', () => {
    const store = new EventStore(1000, render);
    for (const [i, v] of [10, 20, 20, 40].entries()) {
      add(store, logOf('p', i + 1, v));
    }
    const latest = store.latestAt('/p/a.ts', 5)!;
    const md = hoverMarkdown(latest, CONFIG, hoverExtras(store, latest, CONFIG));
    assert.match(md, /\*\*Numeric\*\* — min 10 · max 40 · avg 22.5 · 4 samples/);
    assert.match(md, /\*\*History\*\* — last 4 of 4 runs/);
    const order = [...md.matchAll(/- `#([\d–#]+)`/g)].map((m) => m[1]);
    assert.deepEqual(order, ['4', '2–#3', '1']);
    assert.match(md, /`#2–#3` `20` ×2/);
  });

  it('omits the history when hoverHistory is 0 or there is only one run', () => {
    const store = new EventStore(1000, render);
    add(store, logOf('p', 1, 5));
    const only = store.latestAt('/p/a.ts', 5)!;
    assert.doesNotMatch(hoverMarkdown(only, CONFIG, hoverExtras(store, only, CONFIG)), /\*\*History\*\*/);

    add(store, logOf('p', 2, 6));
    const latest = store.latestAt('/p/a.ts', 5)!;
    const off = { ...CONFIG, hoverHistory: 0 };
    const hiddenHistory = hoverMarkdown(latest, off, hoverExtras(store, latest, off));
    assert.doesNotMatch(hiddenHistory, /\*\*History\*\*/);
    assert.match(hiddenHistory, /Open all 2 runs/, 'the Explorer link stays available even with the inline history off');
    assert.equal(hoverMarkdown(latest, CONFIG), hoverMarkdown(latest, CONFIG, undefined));
  });

  it('a backtick or newline inside a logged value cannot break out of its code span', () => {
    const store = new EventStore(1000, render);
    add(store, logOf('p', 1, 'a`b\nc'));
    add(store, logOf('p', 2, 'fine'));
    const latest = store.latestAt('/p/a.ts', 5)!;
    const md = hoverMarkdown(latest, CONFIG, hoverExtras(store, latest, CONFIG));
    const row = md.split('\n').find((l) => l.startsWith('- `#1`'))!;
    assert.ok(row, 'history row for run #1 is present on a single line');
    assert.equal((row.match(/`/g) ?? []).length, 4, 'exactly two balanced code spans');
  });
});

describe('probe scope: "open all runs in the Explorer"', () => {
  function seeded(): EventStore {
    const store = new EventStore(1000, render);
    for (let i = 1; i <= 6; i++) {
      add(store, logOf('hot', i, i * 10));
      add(store, logOf('other', i, `o${i}`));
    }
    return store;
  }

  it('list() narrows to one probe, newest first, honouring the limit', () => {
    const store = seeded();
    assert.equal(store.list(100).length, 12);
    store.setFilter({ probe: 'hot', probeLabel: 'a.ts:5' });
    assert.deepEqual(store.list(100).map((s) => s.event.count), [6, 5, 4, 3, 2, 1]);
    assert.deepEqual(store.list(2).map((s) => s.event.count), [6, 5]);
    assert.ok(store.list(100).every((s) => s.event.id === 'hot'));
    store.setFilter({ probe: 'no-such-probe' });
    assert.deepEqual(store.list(100), []);
  });

  it('still honours the other filters inside the scope', () => {
    const store = seeded();
    store.setFilter({ probe: 'hot', query: '40' });
    assert.deepEqual(store.list(100).map((s) => s.event.count), [4]);
  });

  it('leaving the scope restores the full list', () => {
    const store = seeded();
    store.setFilter({ probe: 'hot' });
    store.setFilter({ probe: undefined, probeLabel: undefined });
    assert.equal(store.list(100).length, 12);
  });

  it('scoped list() reads only that probe: it stays correct after the ring buffer evicts', () => {
    const store = new EventStore(50, render);
    for (let i = 1; i <= 100; i++) {
      add(store, logOf(i % 2 ? 'odd' : 'even', i, i));
    }
    store.setFilter({ probe: 'even' });
    const counts = store.list(1000).map((s) => s.event.id + ':' + s.event.count);
    assert.ok(counts.length > 0 && counts.length <= 25);
    assert.ok(counts.every((c) => c.startsWith('even:')));
    assert.equal(store.list(1)[0].event.count, 100);
  });

  it('Clear drops the scope, since the scoped history no longer exists', () => {
    const store = seeded();
    store.setFilter({ probe: 'hot', probeLabel: 'a.ts:5', query: 'x' });
    store.clear();
    assert.equal(store.filter.probe, undefined);
    assert.equal(store.filter.probeLabel, undefined);
    assert.equal(store.filter.query, 'x', 'a text filter is still the user\'s choice');
  });

  it('the hover carries a link whose argument round-trips to the probe id', () => {
    const store = new EventStore(1000, render);
    for (let i = 1; i <= 3; i++) {
      add(store, logOf('probe/with space&odd?id', i, i));
    }
    const latest = store.latestAt('/p/a.ts', 5)!;
    const md = hoverMarkdown(latest, CONFIG, hoverExtras(store, latest, CONFIG));
    const match = md.match(/\]\(command:(runtimeLens\.showProbeHistory)\?([^)]*)\)/);
    assert.ok(match, 'link present');
    assert.equal(match![1], SHOW_PROBE_HISTORY_COMMAND);
    assert.deepEqual(JSON.parse(decodeURIComponent(match![2])), ['probe/with space&odd?id']);
    assert.match(md, /Open all 3 runs/);
  });

  it('no link on a first run, and none in tooltips that pass no extras', () => {
    const store = new EventStore(1000, render);
    add(store, logOf('p', 1, 1));
    const only = store.latestAt('/p/a.ts', 5)!;
    assert.doesNotMatch(hoverMarkdown(only, CONFIG, hoverExtras(store, only, CONFIG)), /command:/);
    add(store, logOf('p', 2, 2));
    const latest = store.latestAt('/p/a.ts', 5)!;
    assert.doesNotMatch(hoverMarkdown(latest, CONFIG), /command:/);
  });

  it('the command id is contributed, and hidden from the palette because it needs an argument', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    const ids = pkg.contributes.commands.map((c: { command: string }) => c.command);
    assert.ok(ids.includes(SHOW_PROBE_HISTORY_COMMAND));
    const hidden = pkg.contributes.menus.commandPalette.find(
      (m: { command: string }) => m.command === SHOW_PROBE_HISTORY_COMMAND
    );
    assert.equal(hidden?.when, 'false');
    const registered = readFileSync(path.resolve(__dirname, '../../src/commands/index.ts'), 'utf8');
    assert.ok(registered.includes(`'${SHOW_PROBE_HISTORY_COMMAND}'`), 'registered in commands/index.ts');
  });
});

describe('webview contract: scope', () => {
  const stats = { size: 0, capacity: 10, dropped: 0, totalAdded: 0 };
  const snap = { type: 'snapshot', events: [], follow: true, paused: false, filter: '', stats };

  it('accepts an optional string scope and rejects a malformed one', () => {
    assert.ok(parseHostMessage(snap));
    assert.equal((parseHostMessage({ ...snap, scope: 'cart.ts:12' }) as { scope?: string }).scope, 'cart.ts:12');
    assert.equal(parseHostMessage({ ...snap, scope: 42 }), undefined);
  });

  it('the reducer keeps the scope from the latest snapshot and clears it when absent', () => {
    let state = initialState();
    assert.equal(state.scope, undefined);
    state = reduce(state, { type: 'snapshot', message: { ...snap, scope: 'cart.ts:12' } as never });
    assert.equal(state.scope, 'cart.ts:12');
    state = reduce(state, { type: 'snapshot', message: snap as never });
    assert.equal(state.scope, undefined);
  });

  it('clear-scope is a valid webview message', () => {
    assert.deepEqual(parseWebviewMessage({ type: 'clear-scope' }), { type: 'clear-scope' });
  });
});
