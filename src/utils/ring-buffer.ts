/** Fixed-capacity FIFO ring buffer. Oldest items are dropped on overflow. */
export class RingBuffer<T> implements Iterable<T> {
  private items: Array<T | undefined>;
  private head = 0;
  private count = 0;
  private droppedCount = 0;

  constructor(private capacityValue: number) {
    if (!Number.isInteger(capacityValue) || capacityValue < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacityValue}`);
    }
    this.items = new Array<T | undefined>(capacityValue);
  }

  get capacity(): number {
    return this.capacityValue;
  }

  get size(): number {
    return this.count;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  push(item: T): void {
    const index = (this.head + this.count) % this.capacityValue;
    if (this.count === this.capacityValue) {
      this.items[index] = item;
      this.head = (this.head + 1) % this.capacityValue;
      this.droppedCount++;
    } else {
      this.items[index] = item;
      this.count++;
    }
  }

  /** Remove and return up to `n` oldest items. */
  drain(n = this.count): T[] {
    const take = Math.min(n, this.count);
    const out: T[] = [];
    for (let i = 0; i < take; i++) {
      const index = (this.head + i) % this.capacityValue;
      out.push(this.items[index] as T);
      this.items[index] = undefined;
    }
    this.head = (this.head + take) % this.capacityValue;
    this.count -= take;
    return out;
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      out.push(this.items[(this.head + i) % this.capacityValue] as T);
    }
    return out;
  }

  /** Newest-first iteration without copying the whole buffer twice. */
  *reversed(): IterableIterator<T> {
    for (let i = this.count - 1; i >= 0; i--) {
      yield this.items[(this.head + i) % this.capacityValue] as T;
    }
  }

  [Symbol.iterator](): Iterator<T> {
    return this.toArray()[Symbol.iterator]();
  }

  clear(): void {
    this.items = new Array<T | undefined>(this.capacityValue);
    this.head = 0;
    this.count = 0;
  }

  /** Grow/shrink in place, keeping the newest items. */
  resize(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    const keep = this.toArray().slice(-capacity);
    this.capacityValue = capacity;
    this.items = new Array<T | undefined>(capacity);
    this.head = 0;
    this.count = 0;
    for (const item of keep) {
      this.push(item);
    }
  }
}
