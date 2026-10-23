import type { RuntimeEvent, SerializedValue } from '../protocol';
import { utf8ByteLength } from '../utils/bytes';

/**
 * Last-resort shrinking for ONE event that alone is bigger than the agent's
 * per-batch byte budget.
 *
 * Why it exists: a message over the server's `maxPayload` is not rejected
 * politely, the WebSocket library closes the whole connection ("Max payload
 * size exceeded") and every session event after it is lost. Large
 * `runtimeLens.maxEntries` / `maxNodes` settings make a single huge event
 * realistic, and no setting should be able to take the session down. So such
 * an event is degraded (fewer entries, shorter text, clearly marked as cut)
 * until it fits, instead of being sent as is.
 *
 * Plain TypeScript with no Node dependency (it ships in the browser agent too).
 */

/** Progressively harsher limits tried in turn, until the event fits. */
const LEVELS: ReadonlyArray<{ entries: number; text: number }> = [
  { entries: 50, text: 2_000 },
  { entries: 20, text: 500 },
  { entries: 5, text: 200 },
  { entries: 1, text: 80 }
];

/** Defensive: serialized values are shallow (the serializer bounds depth), this just guards a hostile shape. */
const MAX_DEPTH = 32;

export const OVERSIZE_HINT = 'value too large to send; raise runtimeLens.maxPayloadBytes or lower runtimeLens.maxEntries / runtimeLens.maxNodes';

const cutText = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** A copy of `value` with every container cut to `entries` and every string to `text` characters. */
export function shrinkValue(value: SerializedValue, entries: number, text: number, depth = 0): SerializedValue {
  if (depth > MAX_DEPTH) {
    return { k: 'maxdepth', hint: 'too deep to send' };
  }
  switch (value.k) {
    case 'string':
      return value.v.length > text
        ? { k: 'string', v: value.v.slice(0, text), truncated: true, length: value.length ?? value.v.length }
        : value;
    case 'array':
    case 'set': {
      const kept = value.entries.slice(0, entries).map((entry) => shrinkValue(entry, entries, text, depth + 1));
      return { ...value, entries: kept, ...(kept.length < value.entries.length ? { truncated: true } : {}) } as SerializedValue;
    }
    case 'object': {
      const kept = value.entries.slice(0, entries).map(([key, entry]) => [cutText(key, text), shrinkValue(entry, entries, text, depth + 1)] as [string, SerializedValue]);
      return { ...value, entries: kept, ...(kept.length < value.entries.length ? { truncated: true } : {}) };
    }
    case 'map': {
      const kept = value.entries
        .slice(0, entries)
        .map(([key, entry]) => [shrinkValue(key, entries, text, depth + 1), shrinkValue(entry, entries, text, depth + 1)] as [SerializedValue, SerializedValue]);
      return { ...value, entries: kept, ...(kept.length < value.entries.length ? { truncated: true } : {}) };
    }
    case 'error': {
      const shrunk: SerializedValue = { ...value, message: cutText(value.message, text) };
      if (shrunk.k === 'error') {
        if (value.stack !== undefined) {
          shrunk.stack = cutText(value.stack, text * 2);
        }
        if (value.props) {
          const props: Record<string, SerializedValue> = {};
          for (const [key, prop] of Object.entries(value.props).slice(0, entries)) {
            props[key] = shrinkValue(prop, entries, text, depth + 1);
          }
          shrunk.props = props;
        }
      }
      return shrunk;
    }
    default:
      return value;
  }
}

const oversize = (bytes: number): SerializedValue => ({ k: 'unserializable', hint: `${OVERSIZE_HINT} (${bytes} bytes)` });

const eventBytes = (event: RuntimeEvent): number => utf8ByteLength(JSON.stringify(event));

function withLevel(event: RuntimeEvent, entries: number, text: number): RuntimeEvent {
  switch (event.t) {
    case 'log':
      return { ...event, args: event.args.map((arg) => shrinkValue(arg, entries, text)) };
    case 'expr':
      return { ...event, value: shrinkValue(event.value, entries, text) };
    case 'error':
      return { ...event, message: cutText(event.message, text), stack: event.stack === undefined ? undefined : cutText(event.stack, text * 2) };
    default:
      return event;
  }
}

/**
 * Return `event` unchanged if it fits in `maxBytes`, otherwise the least
 * degraded copy that does. Never throws, never returns something bigger than
 * the input, and always terminates (a fixed number of attempts).
 */
export function shrinkEvent(event: RuntimeEvent, maxBytes: number): RuntimeEvent {
  const original = eventBytes(event);
  if (original <= maxBytes) {
    return event;
  }
  for (const level of LEVELS) {
    const candidate = withLevel(event, level.entries, level.text);
    if (eventBytes(candidate) <= maxBytes) {
      return candidate;
    }
  }
  // Still too big (e.g. a huge console.table, or enormous keys): replace the payload outright.
  let last: RuntimeEvent;
  switch (event.t) {
    case 'log':
      last = { ...event, args: [oversize(original)], table: undefined };
      break;
    case 'expr':
      last = { ...event, value: oversize(original) };
      break;
    case 'error':
      last = { ...event, message: cutText(event.message, 500), stack: undefined };
      break;
    default:
      last = event;
  }
  return last;
}
