/**
 * Trailing-edge throttle: runs at most once per `intervalMs`, and always runs
 * once more after the last call so the UI never ends up stale. Used to keep
 * decoration re-renders bounded when a hot loop floods events.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number
): ((...args: A) => void) & { flush(): void; cancel(): void } {
  let lastRun = 0;
  let timer: NodeJS.Timeout | undefined;
  let pending: A | undefined;

  const run = (args: A): void => {
    lastRun = Date.now();
    pending = undefined;
    fn(...args);
  };

  const throttled = (...args: A): void => {
    const now = Date.now();
    const elapsed = now - lastRun;
    if (elapsed >= intervalMs && timer === undefined) {
      run(args);
      return;
    }
    pending = args;
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        if (pending) {
          run(pending);
        }
      }, Math.max(0, intervalMs - elapsed));
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
    }
  };

  throttled.flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending) {
      run(pending);
    }
  };

  throttled.cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    pending = undefined;
  };

  return throttled;
}

/** Simple debounce used for search boxes and config reloads. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, waitMs: number): (...args: A) => void {
  let timer: NodeJS.Timeout | undefined;
  return (...args: A): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), waitMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  };
}
