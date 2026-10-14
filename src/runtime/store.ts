import type { LogLevel, RuntimeEvent, SerializedValue, SourceLocation } from '../protocol';
import { RingBuffer } from '../utils/ring-buffer';
import { TypedEmitter } from '../utils/events';
import { normalizePath } from '../utils/paths';

export interface StoredEvent {
  /**
   * Internal identity: monotonic for the life of the store and deliberately
   * *never* reset by `clear()`. Tree item ids, React keys and the webview's
   * selection all hang off it, so reusing a number after Clear would let a
   * stale UI element match a brand-new event.
   */
  key: number;
  /**
   * Display ordinal: 1-based position in the capture since the last Clear.
   * This is what to show a person ("#3"); it restarts at 1 after Clear and
   * never depends on entries that were cleared.
   */
  index: number;
  event: RuntimeEvent;
  sessionId: string;
  /** Location after source-map remapping. */
  loc: SourceLocation;
  remapped: boolean;
}

export interface StoreEvents {
  added: { events: StoredEvent[] };
  cleared: Record<string, never>;
  'filter-changed': { filter: EventFilter };
}

interface IndexBucket<T> {
  items: T[];
  head: number;
}

export interface EventFilter {
  /** Case-insensitive substring match over the rendered text and file path. */
  query: string;
  levels: Set<LogLevel> | undefined;
  /** Only events from this absolute file path. */
  file?: string;
  kinds?: Set<RuntimeEvent['t']>;
  /**
   * Only runs of this one probe (a single `console.log` / `// ?` site). Set by
   * "show all runs" in the hover; it narrows the tree view and the Explorer
   * panel alike, because both read this shared filter.
   */
  probe?: string;
  /** Human label for `probe` (e.g. `cart.ts:12`), shown where the scope is displayed. */
  probeLabel?: string;
}

export const EMPTY_FILTER: EventFilter = { query: '', levels: undefined };

/** How many recent numeric values each probe remembers for the sparkline. */
export const TRAIL_SIZE = 8;

/**
 * Running numeric summary of one probe (one `console.log(x)` / `// ?` site).
 *
 * Every update is O(1) and allocation-free: a few comparisons, one addition
 * and one write into a fixed-size typed array. It is deliberately *not*
 * derived from the bounded history, so min/max/avg stay correct for the whole
 * run even after the ring buffer has dropped the old events. It is reset by
 * `EventStore.clear()` and never by a history resize.
 */
export class ProbeStats {
  /** Finite numeric values seen since the last Clear. */
  numeric = 0;
  min = Infinity;
  max = -Infinity;
  sum = 0;
  private readonly ring = new Float64Array(TRAIL_SIZE);

  push(value: number): void {
    this.ring[this.numeric % TRAIL_SIZE] = value;
    this.numeric++;
    if (value < this.min) {
      this.min = value;
    }
    if (value > this.max) {
      this.max = value;
    }
    this.sum += value;
  }

  /** Mean, or undefined when empty or when the running sum overflowed. */
  get avg(): number | undefined {
    return this.numeric > 0 && Number.isFinite(this.sum) ? this.sum / this.numeric : undefined;
  }

  /** The most recent numeric values, oldest first (allocates; call at render time only). */
  trail(): number[] {
    const n = Math.min(this.numeric, TRAIL_SIZE);
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      out[i] = this.ring[(this.numeric - n + i) % TRAIL_SIZE];
    }
    return out;
  }
}

/**
 * The single numeric value an event carries, if it has exactly one and it is a
 * finite number (`console.log(total)` or `total // ?`). Anything else - several
 * arguments, objects, NaN/Infinity - is not part of the numeric summary.
 */
export function numericValueOf(event: RuntimeEvent): number | undefined {
  let value: SerializedValue | undefined;
  if (event.t === 'log') {
    value = event.args.length === 1 ? event.args[0] : undefined;
  } else if (event.t === 'expr') {
    value = event.value;
  }
  if (value !== undefined && value.k === 'number' && typeof value.v === 'number' && Number.isFinite(value.v)) {
    return value.v;
  }
  return undefined;
}

/**
 * Bounded event history plus per-line indexes.
 *
 * The store keeps two derived structures so the editor layer never has to scan
 * history: `byLine` (latest event per file:line, what inline decorations need)
 * and `countsByProbe` (execution counts, what `// => v × N` needs). Both are
 * O(1) per event, which is what makes a 50k-events-per-second hot loop
 * survivable.
 */
export class EventStore {
  readonly emitter = new TypedEmitter<StoreEvents>();
  private buffer: RingBuffer<StoredEvent>;
  private nextKey = 1;
  private readonly byLine = new Map<string, StoredEvent>();
  private readonly countsByProbe = new Map<string, number>();
  private readonly lineHistory = new Map<string, IndexBucket<StoredEvent>>();
  private readonly probeHistory = new Map<string, IndexBucket<StoredEvent>>();
  private readonly statsByProbe = new Map<string, ProbeStats>();
  private filterValue: EventFilter = { ...EMPTY_FILTER };
  private totalAdded = 0;

  constructor(maxHistory: number, private readonly renderText: (event: RuntimeEvent) => string) {
    this.buffer = new RingBuffer<StoredEvent>(Math.max(50, maxHistory));
  }

  get filter(): EventFilter {
    return this.filterValue;
  }

  setFilter(filter: Partial<EventFilter>): void {
    this.filterValue = { ...this.filterValue, ...filter };
    this.emitter.emit('filter-changed', { filter: this.filterValue });
  }

  setMaxHistory(maxHistory: number): void {
    this.buffer.resize(Math.max(50, maxHistory));
    this.rebuildIndexes();
  }

  add(entries: Array<{ event: RuntimeEvent; sessionId: string; loc: SourceLocation; remapped: boolean }>): StoredEvent[] {
    const stored: StoredEvent[] = [];
    for (const entry of entries) {
      this.totalAdded++;
      const item: StoredEvent = { key: this.nextKey++, index: this.totalAdded, ...entry };
      const evicted = this.buffer.push(item);
      this.indexAdded(item);
      this.recordStats(item);
      if (evicted) {
        this.indexRemoved(evicted);
      }
      stored.push(item);
    }
    if (stored.length > 0) {
      this.emitter.emit('added', { events: stored });
    }
    return stored;
  }

  clear(): void {
    this.buffer.clear();
    this.byLine.clear();
    this.countsByProbe.clear();
    this.lineHistory.clear();
    this.probeHistory.clear();
    this.statsByProbe.clear();
    // The scoped probe's history just vanished; leaving the scope on would show an
    // empty list under a label for something that no longer exists.
    this.filterValue = { ...this.filterValue, probe: undefined, probeLabel: undefined };
    this.totalAdded = 0;
    this.emitter.emit('cleared', {} as Record<string, never>);
  }

  /** Look an event up by its internal key, ignoring the active filter. */
  find(key: number): StoredEvent | undefined {
    for (const item of this.buffer.reversed()) {
      if (item.key === key) {
        return item;
      }
    }
    return undefined;
  }

  /** Newest-first list honouring the active filter. */
  list(limit = 500): StoredEvent[] {
    const out: StoredEvent[] = [];
    const probe = this.filterValue.probe;
    if (probe !== undefined) {
      // Scoped to one probe: walk just that probe's bucket instead of the
      // whole buffer, so the cost is O(limit) however busy other probes are.
      const bucket = this.probeHistory.get(probe);
      if (bucket) {
        for (let i = bucket.items.length - 1; i >= bucket.head && out.length < limit; i--) {
          if (this.matches(bucket.items[i])) {
            out.push(bucket.items[i]);
          }
        }
      }
      return out;
    }
    for (const item of this.buffer.reversed()) {
      if (this.matches(item)) {
        out.push(item);
        if (out.length >= limit) {
          break;
        }
      }
    }
    return out;
  }

  /** Latest event on each line of a file (what the decorator renders). */
  forFile(file: string): StoredEvent[] {
    const target = normalizePath(file);
    const out: StoredEvent[] = [];
    for (const [key, item] of this.byLine) {
      if (key.slice(0, key.lastIndexOf(':')) === target) {
        out.push(item);
      }
    }
    return out.sort((a, b) => a.loc.line - b.loc.line);
  }

  latestAt(file: string, line: number): StoredEvent | undefined {
    return this.byLine.get(lineKey(file, line));
  }

  countFor(probeId: string): number {
    return this.countsByProbe.get(probeId) ?? 0;
  }

  /**
   * Recent events of one probe, newest first, at most `limit`. Reads the tail
   * of an existing per-probe bucket, so the cost is O(limit) no matter how
   * long the history is.
   */
  historyOf(probeId: string, limit = 10): StoredEvent[] {
    const bucket = this.probeHistory.get(probeId);
    if (!bucket || limit <= 0) {
      return [];
    }
    const out: StoredEvent[] = [];
    for (let i = bucket.items.length - 1; i >= bucket.head && out.length < limit; i--) {
      out.push(bucket.items[i]);
    }
    return out;
  }

  /** The event that ran at the same probe immediately before `stored`, if still retained. */
  previousOf(stored: StoredEvent): StoredEvent | undefined {
    const bucket = this.probeHistory.get(stored.event.id);
    if (!bucket) {
      return undefined;
    }
    // `stored` is almost always the tail; scan from the end so a stale
    // argument still resolves correctly.
    for (let i = bucket.items.length - 1; i > bucket.head; i--) {
      if (bucket.items[i].key === stored.key) {
        return bucket.items[i - 1];
      }
    }
    return undefined;
  }

  /** Numeric summary for a probe since the last Clear (undefined if it never produced a number). */
  statsOf(probeId: string): ProbeStats | undefined {
    return this.statsByProbe.get(probeId);
  }

  private indexAdded(item: StoredEvent): void {
    const line = lineKey(item.loc.file, item.loc.line);
    appendIndex(this.lineHistory, line, item);
    this.byLine.set(line, item);

    const probe = item.event.id;
    appendIndex(this.probeHistory, probe, item);
    this.countsByProbe.set(probe, item.event.count);
  }

  private indexRemoved(item: StoredEvent): void {
    const line = lineKey(item.loc.file, item.loc.line);
    const lineBucket = this.lineHistory.get(line);
    if (lineBucket) {
      advanceBucketPast(lineBucket, item);
      if (lineBucket.head >= lineBucket.items.length) {
        this.lineHistory.delete(line);
        this.byLine.delete(line);
      } else if (this.byLine.get(line)?.key === item.key) {
        this.byLine.set(line, lineBucket.items[lineBucket.items.length - 1]);
      }
    }

    const probe = item.event.id;
    const probeBucket = this.probeHistory.get(probe);
    if (probeBucket) {
      advanceBucketPast(probeBucket, item);
      if (probeBucket.head >= probeBucket.items.length) {
        this.probeHistory.delete(probe);
        this.countsByProbe.delete(probe);
      } else if (this.countsByProbe.has(probe)) {
        const latest = probeBucket.items[probeBucket.items.length - 1];
        this.countsByProbe.set(probe, latest.event.count);
      }
    }
  }

  private recordStats(item: StoredEvent): void {
    const value = numericValueOf(item.event);
    if (value === undefined) {
      return;
    }
    const id = item.event.id;
    let stats = this.statsByProbe.get(id);
    if (!stats) {
      stats = new ProbeStats();
      this.statsByProbe.set(id, stats);
    }
    stats.push(value);
  }

  private rebuildIndexes(): void {
    this.byLine.clear();
    this.countsByProbe.clear();
    this.lineHistory.clear();
    this.probeHistory.clear();
    for (const item of this.buffer) {
      this.indexAdded(item);
    }
  }

  stats(): { size: number; capacity: number; dropped: number; totalAdded: number; lines: number; probes: number } {
    return {
      size: this.buffer.size,
      capacity: this.buffer.capacity,
      dropped: this.buffer.dropped,
      totalAdded: this.totalAdded,
      lines: this.byLine.size,
      probes: this.countsByProbe.size
    };
  }

  matches(item: StoredEvent): boolean {
    const f = this.filterValue;
    if (f.kinds && !f.kinds.has(item.event.t)) {
      return false;
    }
    if (f.levels) {
      // An active level filter is an explicit request for console output:
      // expression probes and runtime errors carry no level, so they are
      // hidden rather than leaking through the filter. `error` events are the
      // one exception - they are shown when 'error' is selected.
      if (item.event.t === 'log') {
        if (!f.levels.has(item.event.level)) {
          return false;
        }
      } else if (item.event.t === 'error') {
        if (!f.levels.has('error')) {
          return false;
        }
      } else {
        return false;
      }
    }
    if (f.probe !== undefined && f.probe !== item.event.id) {
      return false;
    }
    if (f.file && normalizePath(f.file) !== normalizePath(item.loc.file)) {
      return false;
    }
    if (f.query.length > 0) {
      const needle = f.query.toLowerCase();
      const haystack = `${this.renderText(item.event)} ${item.loc.file}`.toLowerCase();
      if (!haystack.includes(needle)) {
        return false;
      }
    }
    return true;
  }
}

function appendIndex<T>(map: Map<string, IndexBucket<T>>, key: string, item: T): void {
  const bucket = map.get(key);
  if (bucket) {
    bucket.items.push(item);
    return;
  }
  map.set(key, { items: [item], head: 0 });
}

function advanceBucketPast<T extends StoredEvent>(bucket: IndexBucket<T>, item: T): void {
  if (bucket.head >= bucket.items.length || bucket.items[bucket.head]?.key !== item.key) {
    return;
  }
  bucket.head++;
  // Drop consumed prefixes periodically so a hot line/probe stays bounded.
  if (bucket.head >= 32 && bucket.head * 2 >= bucket.items.length) {
    bucket.items = bucket.items.slice(bucket.head);
    bucket.head = 0;
  }
}

export function lineKey(file: string, line: number): string {
  return `${normalizePath(file)}:${line}`;
}
