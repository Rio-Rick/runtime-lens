/**
 * Clamp into [min, max] and round down. Settings feed `new RingBuffer(n)`,
 * `listen(port)` and similar APIs that throw on a fractional number, so a value
 * like `"runtimeLens.maxHistory": 5000.5` must never reach them as is (it made
 * the whole extension fail to activate).
 */
export function clampInt(value: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}
