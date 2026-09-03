import type { LogLevel, RuntimeEvent, SourceLocation } from '../protocol';
import { RingBuffer } from '../utils/ring-buffer';
import { TypedEmitter } from '../utils/events';
import { normalizePath } from '../utils/paths';

export interface StoredEvent {
  /** Monotonic id assigned by the store (stable for tree items). */
  key: number;
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

export interface EventFilter {
  /** Case-insensitive substring match over the rendered text and file path. */
  query: string;
  levels: Set<LogLevel> | undefined;
  /** Only events from this absolute file path. */
  file?: string;
  kinds?: Set<RuntimeEvent['t']>;
}

export const EMPTY_FILTER: EventFilter = { query: '', levels: undefined };

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
  }

  add(entries: Array<{ event: RuntimeEvent; sessionId: string; loc: SourceLocation; remapped: boolean }>): StoredEvent[] {
    const stored: StoredEvent[] = [];
    for (const entry of entries) {
      const item: StoredEvent = { key: this.nextKey++, ...entry };
      this.buffer.push(item);
      this.byLine.set(lineKey(item.loc.file, item.loc.line), item);
      this.countsByProbe.set(item.event.id, item.event.count);
      this.totalAdded++;
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
    this.emitter.emit('cleared', {} as Record<string, never>);
  }

  /** Newest-first list honouring the active filter. */
  list(limit = 500): StoredEvent[] {
    const out: StoredEvent[] = [];
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

export function lineKey(file: string, line: number): string {
  return `${normalizePath(file)}:${line}`;
}
