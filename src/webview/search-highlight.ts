/**
 * Search-match highlighting for the Webview.
 *
 * The *filtering* of events stays on the host (`EventStore.matches`: a
 * case-insensitive substring test). This module only answers "which parts of
 * a string that is already on screen matched?", so it must agree with that
 * rule: the query is a literal substring, never a pattern.
 *
 * It is plain TypeScript with no React or DOM dependency so it can be
 * unit-tested under Node and reused by every component that shows text.
 */

/**
 * Most highlighted matches rendered inside one piece of text. A one-letter
 * query against a long value would otherwise create thousands of `<mark>`
 * elements; past the cap the remainder is shown as ordinary text.
 */
export const MAX_HIGHLIGHTS = 200;

export interface Matcher {
  /** The literal text being searched for (never empty). */
  readonly query: string;
  /**
   * Global, case-insensitive pattern built from the *escaped* query. It is
   * stateful (`lastIndex`), so `splitByMatches` resets it before and after use.
   */
  readonly pattern: RegExp;
}

export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/g;

/** `undefined` for an empty query, which means "render normally, no highlights". */
export function createMatcher(query: string): Matcher | undefined {
  if (query.length === 0) {
    return undefined;
  }
  return { query, pattern: new RegExp(query.replace(REGEXP_SPECIAL, '\\$&'), 'gi') };
}

/**
 * Split `text` into alternating plain / matching segments. The segments always
 * concatenate back to exactly `text`: matches are slices of the original, so
 * the original casing and characters are never altered.
 */
export function splitByMatches(text: string, matcher: Matcher | undefined): readonly Segment[] {
  if (!matcher || text.length === 0) {
    return [{ text, match: false }];
  }
  const { pattern } = matcher;
  pattern.lastIndex = 0;
  const out: Segment[] = [];
  let last = 0;
  let count = 0;
  let found: RegExpExecArray | null;
  while (count < MAX_HIGHLIGHTS && (found = pattern.exec(text)) !== null) {
    if (found[0].length === 0) {
      // Unreachable for a non-empty literal query; guards against an endless loop regardless.
      pattern.lastIndex++;
      continue;
    }
    if (found.index > last) {
      out.push({ text: text.slice(last, found.index), match: false });
    }
    out.push({ text: found[0], match: true });
    last = found.index + found[0].length;
    count++;
  }
  pattern.lastIndex = 0;
  if (last < text.length) {
    out.push({ text: text.slice(last), match: false });
  }
  return out;
}

/** How many times the query occurs in `text` (uncapped, unlike the highlights). */
export function countMatches(text: string, matcher: Matcher | undefined): number {
  if (!matcher || text.length === 0) {
    return 0;
  }
  const { pattern } = matcher;
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text) !== null) {
    count++;
  }
  pattern.lastIndex = 0;
  return count;
}
