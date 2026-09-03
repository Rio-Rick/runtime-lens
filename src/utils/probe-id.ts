import { createHash } from 'node:crypto';

/**
 * Runtime Lens' distinctive trick: **content-addressed probe identity**.
 *
 * A probe id is derived from (workspace-relative file, probe kind, the exact
 * source text of the probed expression, and the 1-based line). Because the
 * expression text participates in the hash, moving a line of code up or down
 * keeps the *value stream* attached to the same logical probe only when the
 * code is identical, while editing the expression deliberately creates a new
 * identity. That gives three properties we care about:
 *
 *  1. Ids are stable across process restarts (no counters, no PIDs).
 *  2. Ids are stable across bundlers, since they are computed at transform
 *     time from the original source, not from generated output.
 *  3. Ids are cheap: a 12-hex-char truncated sha1 collides with probability
 *     ~1e-9 for the thousands of probes a real project has, and a collision
 *     only mixes two value streams in the UI - it cannot corrupt code.
 */
export function computeProbeId(input: {
  file: string;
  kind: 'log' | 'expr' | 'error';
  text: string;
  line: number;
}): string {
  const normalizedFile = input.file.replace(/\\/g, '/');
  const normalizedText = input.text.replace(/\s+/g, ' ').trim();
  const hash = createHash('sha1');
  hash.update(`${normalizedFile}\u0000${input.kind}\u0000${normalizedText}\u0000${input.line}`);
  return hash.digest('hex').slice(0, 12);
}

/** Human-readable, unique key for a location (used for decoration grouping). */
export function locationKey(file: string, line: number): string {
  return `${file.replace(/\\/g, '/')}:${line}`;
}
