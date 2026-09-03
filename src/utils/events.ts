/**
 * Minimal, dependency-free typed event emitter.
 *
 * Deliberately not `vscode.EventEmitter`: the runtime/instrumentation layers
 * must be unit-testable in plain Node without the `vscode` module present.
 */
export type Listener<T> = (payload: T) => void;

export interface Unsubscribe {
  dispose(): void;
}

export class TypedEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();
  private disposed = false;

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    if (this.disposed) {
      throw new Error('TypedEmitter has been disposed');
    }
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return {
      dispose: () => {
        this.listeners.get(event)?.delete(listener as Listener<never>);
      }
    };
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): Unsubscribe {
    const sub = this.on(event, (payload) => {
      sub.dispose();
      listener(payload);
    });
    return sub;
  }

  /**
   * Emit to every listener. A throwing listener never prevents the remaining
   * listeners from running; errors are collected and reported via `onError`.
   */
  emit<K extends keyof Events>(event: K, payload: Events[K]): number {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) {
      return 0;
    }
    let delivered = 0;
    for (const listener of [...set]) {
      try {
        (listener as Listener<Events[K]>)(payload);
        delivered++;
      } catch (err) {
        this.onError?.(err as Error, String(event));
      }
    }
    return delivered;
  }

  onError?: (err: Error, event: string) => void;

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  removeAll(event?: keyof Events): void {
    if (event === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(event);
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.disposed = true;
  }
}
