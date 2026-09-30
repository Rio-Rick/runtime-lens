import type { DetailMessage, SnapshotMessage, WireEvent, WireStats } from './messages';

/**
 * The Webview's state as a pure reducer. Keeping it free of React makes the
 * tricky parts — selection after a snapshot, "follow", clearing, and the
 * detail cache — unit-testable, and gives React one predictable data flow
 * (`dispatch(action)`) instead of several `setState` calls that have to stay
 * in sync by hand.
 */

/** How many fetched event details to keep. Only recent selections are worth caching. */
export const MAX_CACHED_DETAILS = 8;

export interface ViewState {
  /** Newest first, exactly as the host sent them. */
  events: readonly WireEvent[];
  selectedKey: number | null;
  follow: boolean;
  paused: boolean;
  /** The host's text filter as of the last snapshot. */
  filter: string;
  stats: WireStats;
  details: ReadonlyMap<number, DetailMessage>;
  /** Keys the host said it no longer has, so we don't ask again. */
  missing: ReadonlySet<number>;
}

export type Action =
  | { type: 'snapshot'; message: SnapshotMessage }
  | { type: 'detail'; message: DetailMessage }
  | { type: 'detail-missing'; key: number }
  | { type: 'select'; key: number }
  | { type: 'set-follow'; value: boolean }
  | { type: 'set-paused'; value: boolean };

export const EMPTY_STATS: WireStats = { size: 0, capacity: 0, dropped: 0, totalAdded: 0 };

export function initialState(): ViewState {
  return {
    events: [],
    selectedKey: null,
    follow: true,
    paused: false,
    filter: '',
    stats: EMPTY_STATS,
    details: new Map(),
    missing: new Set()
  };
}

/** Picking anything but the newest event means "stop following". */
export function shouldStopFollowing(state: ViewState, key: number): boolean {
  return state.follow && state.events.length > 0 && state.events[0].key !== key;
}

function nextSelection(previous: number | null, events: readonly WireEvent[], follow: boolean): number | null {
  if (events.length === 0) {
    return null;
  }
  if (follow) {
    return events[0].key; // newest first
  }
  return previous !== null && events.some((event) => event.key === previous) ? previous : events[0].key;
}

/**
 * Events are immutable once captured, so an incoming event with a key we
 * already hold *is* the one we hold. Reusing the old object keeps identities
 * stable, which is what lets `React.memo` skip unchanged rows.
 */
function reuseEvents(previous: readonly WireEvent[], incoming: readonly WireEvent[]): readonly WireEvent[] {
  const byKey = new Map(previous.map((event) => [event.key, event]));
  const merged = incoming.map((event) => byKey.get(event.key) ?? event);
  const unchanged = merged.length === previous.length && merged.every((event, i) => event === previous[i]);
  return unchanged ? previous : merged;
}

export function reduce(state: ViewState, action: Action): ViewState {
  switch (action.type) {
    case 'snapshot': {
      const { message } = action;
      const events = reuseEvents(state.events, message.events);
      const live = new Set(events.map((event) => event.key));
      const selectedKey = nextSelection(state.selectedKey, events, message.follow);

      // Drop anything that is no longer in the host's history. After Clear this
      // empties the cache, so the Webview holds no reference to cleared data.
      const details = new Map([...state.details].filter(([key]) => live.has(key)));
      const missing = new Set([...state.missing].filter((key) => live.has(key)));

      return {
        events,
        selectedKey,
        follow: message.follow,
        paused: message.paused,
        filter: message.filter,
        stats: message.stats,
        details,
        missing
      };
    }
    case 'detail': {
      const { message } = action;
      if (!state.events.some((event) => event.key === message.key)) {
        return state; // a reply for an event that has since been cleared
      }
      const details = new Map(state.details);
      details.delete(message.key);
      details.set(message.key, message);
      for (const key of details.keys()) {
        if (details.size <= MAX_CACHED_DETAILS) {
          break;
        }
        if (key !== state.selectedKey) {
          details.delete(key);
        }
      }
      const missing = new Set(state.missing);
      missing.delete(message.key);
      return { ...state, details, missing };
    }
    case 'detail-missing':
      return state.missing.has(action.key) ? state : { ...state, missing: new Set(state.missing).add(action.key) };
    case 'select':
      if (!state.events.some((event) => event.key === action.key)) {
        return state;
      }
      return { ...state, selectedKey: action.key, follow: shouldStopFollowing(state, action.key) ? false : state.follow };
    case 'set-follow':
      return {
        ...state,
        follow: action.value,
        selectedKey: nextSelection(state.selectedKey, state.events, action.value)
      };
    case 'set-paused':
      return { ...state, paused: action.value };
  }
}
