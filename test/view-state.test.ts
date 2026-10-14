import assert from 'node:assert/strict';
import type { DetailMessage, SnapshotMessage, WireEvent } from '../src/webview/messages';
import { MAX_CACHED_DETAILS, initialState, reduce, shouldStopFollowing, type ViewState } from '../src/webview/view-state';

function ev(key: number, overrides: Partial<WireEvent> = {}): WireEvent {
  return {
    key,
    index: key,
    kind: 'log',
    level: 'log',
    text: `event ${key}`,
    file: '/p/a.ts',
    short: 'p/a.ts',
    line: key,
    count: 1,
    ts: key,
    remapped: false,
    ...overrides
  };
}

function snapshot(events: WireEvent[], overrides: Partial<Omit<SnapshotMessage, 'events' | 'type'>> = {}): SnapshotMessage {
  return {
    type: 'snapshot',
    events,
    follow: true,
    paused: false,
    filter: '',
    stats: { size: events.length, capacity: 100, dropped: 0, totalAdded: events.length },
    ...overrides
  };
}

describe('webview/view-state', () => {
  it('starts empty, unselected, following', () => {
    const state = initialState();
    assert.equal(state.events.length, 0);
    assert.equal(state.selectedKey, null);
    assert.equal(state.follow, true);
  });

  describe('snapshot: selection follows the newest event while follow is on', () => {
    it('selects the newest (first) event on every snapshot', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(1)]) });
      assert.equal(state.selectedKey, 1);
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(2), ev(1)]) });
      assert.equal(state.selectedKey, 2, 'a newer event arrives and follow is on, so selection moves to it');
    });

    it('keeps the previous selection when follow is off and that event still exists', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(1)], { follow: false }) });
      state = reduce(state, { type: 'select', key: 1 });
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(2), ev(1)], { follow: false }) });
      assert.equal(state.selectedKey, 1, 'follow is off: the newer event must not steal the selection');
    });

    it('falls back to the newest event if the selected one is no longer present, even with follow off', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(1)], { follow: false }) });
      state = reduce(state, { type: 'select', key: 1 });
      // event 1 fell out of history (capacity/filter); only 2 and 3 remain
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(3), ev(2)], { follow: false }) });
      assert.equal(state.selectedKey, 3);
    });
  });

  describe('clear produces a clean state', () => {
    it('an empty snapshot (what Clear sends) drops selection, details and missing markers', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(1), ev(2)]) });
      state = reduce(state, { type: 'detail', message: { type: 'detail', key: 1, detail: 'hello' } });
      state = reduce(state, { type: 'detail-missing', key: 2 });
      assert.equal(state.details.size, 1);

      state = reduce(state, {
        type: 'snapshot',
        message: snapshot([], { stats: { size: 0, capacity: 100, dropped: 0, totalAdded: 0 } })
      });
      assert.equal(state.events.length, 0);
      assert.equal(state.selectedKey, null);
      assert.equal(state.details.size, 0, 'the webview must hold no reference to cleared data');
      assert.equal(state.missing.size, 0);
      assert.equal(state.stats.totalAdded, 0);
    });

    it('a display index that restarts at 1 after clear is trusted as-is (the store is the source of truth)', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(1, { index: 1 })]) });
      assert.equal(state.events[0].index, 1);
    });
  });

  describe('detail cache', () => {
    it('is bounded, and never evicts the currently-selected entry', () => {
      let state = initialState();
      const events = Array.from({ length: MAX_CACHED_DETAILS + 5 }, (_, i) => ev(i + 1));
      state = reduce(state, { type: 'snapshot', message: snapshot(events, { follow: false }) });
      state = reduce(state, { type: 'select', key: 1 });

      for (let key = 1; key <= MAX_CACHED_DETAILS + 5; key++) {
        const message: DetailMessage = { type: 'detail', key, detail: `d${key}` };
        state = reduce(state, { type: 'detail', message });
      }
      assert.ok(state.details.size <= MAX_CACHED_DETAILS);
      assert.ok(state.details.has(1), 'the selected entry must survive eviction');
    });

    it('a detail reply for an event that has since been cleared is dropped, not cached', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(1)]) });
      state = reduce(state, { type: 'snapshot', message: snapshot([]) }); // cleared, in flight reply below
      state = reduce(state, { type: 'detail', message: { type: 'detail', key: 1, detail: 'stale' } });
      assert.equal(state.details.size, 0);
    });
  });

  describe('select / follow', () => {
    it('selecting the newest event does not turn follow off', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(2), ev(1)]) });
      assert.equal(shouldStopFollowing(state, 2), false);
    });

    it('selecting an older event signals that follow should stop', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(2), ev(1)]) });
      assert.equal(shouldStopFollowing(state, 1), true);
      state = reduce(state, { type: 'select', key: 1 });
      assert.equal(state.follow, false);
    });

    it('turning follow back on jumps to the newest event immediately', () => {
      let state: ViewState = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(2), ev(1)], { follow: false }) });
      state = reduce(state, { type: 'select', key: 1 });
      state = reduce(state, { type: 'set-follow', value: true });
      assert.equal(state.selectedKey, 2);
    });

    it('selecting a key that no longer exists is ignored', () => {
      let state = initialState();
      state = reduce(state, { type: 'snapshot', message: snapshot([ev(1)]) });
      state = reduce(state, { type: 'select', key: 999 });
      assert.equal(state.selectedKey, 1);
    });
  });
});
