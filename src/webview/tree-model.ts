import type { RuntimeEvent, SerializedValue } from '../protocol';
import { preview, toPlainText } from '../serialization/preview';
import type { DetailMessage } from './messages';
import { countMatches, type Matcher } from './search-highlight';

/**
 * The model behind the expandable value tree in the detail pane.
 *
 * Two sources feed one tree shape:
 *  - a `SerializedValue` the extension already holds (log arguments, probed
 *    values). It is rendered directly: it is already bounded and already
 *    represents `undefined`, circular references, `NaN`, Map/Set and friends,
 *    none of which survive a trip through JSON text;
 *  - a *string* argument that looks like a JSON object/array, parsed here.
 *
 * Nothing in this file touches React or the DOM, so it unit-tests under Node.
 * Children are built lazily: creating a node never walks its subtree, so a
 * large payload costs only what the user actually expands.
 */

// -------------------------------------------------------------- JSON text

/** A parsed JSON value. Numbers keep their source text so no precision is silently lost. */
export type JsonValue =
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'number'; readonly raw: string }
  | { readonly t: 'boolean'; readonly v: boolean }
  | { readonly t: 'null' }
  | { readonly t: 'array'; readonly items: readonly JsonValue[] }
  | { readonly t: 'object'; readonly entries: ReadonlyArray<readonly [string, JsonValue]> };

/** Strings longer than this are never examined (the serializer already caps them far lower). */
export const MAX_JSON_CHARS = 1_000_000;
/** Deeper nesting is rejected, which keeps the recursive parser far from the stack limit. */
export const MAX_JSON_DEPTH = 64;
/** More values than this is rejected, so one payload cannot stall the Webview. */
export const MAX_JSON_NODES = 50_000;

const FAIL = Symbol('invalid-json');
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

const isJsonSpace = (code: number): boolean => code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;

/**
 * Cheap pre-check that decides whether a string is worth parsing at all: it
 * must start with `{`/`[` and end with the matching closer (ignoring JSON
 * whitespace). Plain text, stack traces and numbers fail this in O(1).
 */
export function looksLikeJsonContainer(text: string): boolean {
  if (text.length < 2 || text.length > MAX_JSON_CHARS) {
    return false;
  }
  let start = 0;
  let end = text.length - 1;
  while (start < end && isJsonSpace(text.charCodeAt(start))) {
    start++;
  }
  while (end > start && isJsonSpace(text.charCodeAt(end))) {
    end--;
  }
  const first = text.charCodeAt(start);
  const last = text.charCodeAt(end);
  return (first === 0x7b && last === 0x7d) || (first === 0x5b && last === 0x5d);
}

/**
 * Strict RFC 8259 parser: it accepts exactly what `JSON.parse` accepts (see
 * the agreement test) but keeps number literals verbatim, keeps duplicate
 * keys, and cannot be tricked by a `__proto__` key. Returns `undefined` for
 * anything invalid, too deep or too large; never throws.
 */
export function parseJsonText(text: string): JsonValue | undefined {
  if (text.length > MAX_JSON_CHARS) {
    return undefined;
  }
  const end = text.length;
  let pos = 0;
  let nodes = 0;

  const skipSpace = (): void => {
    while (pos < end && isJsonSpace(text.charCodeAt(pos))) {
      pos++;
    }
  };

  const parseString = (): string => {
    pos++; // opening quote
    let out = '';
    let from = pos;
    for (;;) {
      if (pos >= end) {
        throw FAIL;
      }
      const code = text.charCodeAt(pos);
      if (code === 0x22) {
        out += text.slice(from, pos);
        pos++;
        return out;
      }
      if (code < 0x20) {
        throw FAIL; // raw control characters must be escaped
      }
      if (code !== 0x5c) {
        pos++;
        continue;
      }
      out += text.slice(from, pos);
      pos++;
      switch (text.charCodeAt(pos)) {
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += '\\';
          break;
        case 0x2f:
          out += '/';
          break;
        case 0x62:
          out += '\b';
          break;
        case 0x66:
          out += '\f';
          break;
        case 0x6e:
          out += '\n';
          break;
        case 0x72:
          out += '\r';
          break;
        case 0x74:
          out += '\t';
          break;
        case 0x75: {
          const hex = text.slice(pos + 1, pos + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw FAIL;
          }
          out += String.fromCharCode(Number.parseInt(hex, 16));
          pos += 4;
          break;
        }
        default:
          throw FAIL;
      }
      pos++;
      from = pos;
    }
  };

  const parseValue = (depth: number): JsonValue => {
    if (++nodes > MAX_JSON_NODES) {
      throw FAIL;
    }
    const code = text.charCodeAt(pos);
    switch (code) {
      case 0x7b: {
        if (depth >= MAX_JSON_DEPTH) {
          throw FAIL;
        }
        pos++;
        const entries: Array<readonly [string, JsonValue]> = [];
        skipSpace();
        if (text.charCodeAt(pos) === 0x7d) {
          pos++;
          return { t: 'object', entries };
        }
        for (;;) {
          skipSpace();
          if (text.charCodeAt(pos) !== 0x22) {
            throw FAIL;
          }
          const key = parseString();
          skipSpace();
          if (text.charCodeAt(pos) !== 0x3a) {
            throw FAIL;
          }
          pos++;
          skipSpace();
          entries.push([key, parseValue(depth + 1)]);
          skipSpace();
          const next = text.charCodeAt(pos);
          pos++;
          if (next === 0x2c) {
            continue;
          }
          if (next === 0x7d) {
            return { t: 'object', entries };
          }
          throw FAIL;
        }
      }
      case 0x5b: {
        if (depth >= MAX_JSON_DEPTH) {
          throw FAIL;
        }
        pos++;
        const items: JsonValue[] = [];
        skipSpace();
        if (text.charCodeAt(pos) === 0x5d) {
          pos++;
          return { t: 'array', items };
        }
        for (;;) {
          skipSpace();
          items.push(parseValue(depth + 1));
          skipSpace();
          const next = text.charCodeAt(pos);
          pos++;
          if (next === 0x2c) {
            continue;
          }
          if (next === 0x5d) {
            return { t: 'array', items };
          }
          throw FAIL;
        }
      }
      case 0x22:
        return { t: 'string', v: parseString() };
      case 0x74:
        return literal('true', { t: 'boolean', v: true });
      case 0x66:
        return literal('false', { t: 'boolean', v: false });
      case 0x6e:
        return literal('null', { t: 'null' });
      default: {
        NUMBER.lastIndex = pos;
        const found = NUMBER.exec(text);
        if (!found) {
          throw FAIL;
        }
        pos += found[0].length;
        return { t: 'number', raw: found[0] };
      }
    }
  };

  const literal = (word: string, value: JsonValue): JsonValue => {
    if (!text.startsWith(word, pos)) {
      throw FAIL;
    }
    pos += word.length;
    return value;
  };

  try {
    skipSpace();
    const value = parseValue(0);
    skipSpace();
    if (pos !== end) {
      throw FAIL;
    }
    return value;
  } catch (error) {
    if (error === FAIL) {
      return undefined;
    }
    throw error;
  }
}

// -------------------------------------------------------------- tree nodes

export type LeafClass = 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'empty' | 'other';

export interface LeafNode {
  readonly kind: 'leaf';
  readonly cls: LeafClass;
  /** Exactly what is displayed. */
  readonly text: string;
}

export interface BranchNode {
  readonly kind: 'branch';
  readonly shape: 'object' | 'array' | 'map' | 'set';
  /** Compact label shown on the row, e.g. `Array(3)` or `User {2}`. */
  readonly summary: string;
  /** Children the extension actually holds. */
  readonly size: number;
  /** Children the serializer dropped to stay within its limits (shown as a note, never hidden). */
  readonly omitted: number;
  /** Builds the children on first call and returns the same array afterwards. */
  children(): readonly TreeEntry[];
}

export interface TreeEntry {
  readonly label: string;
  readonly node: TreeNode;
}

export type TreeNode = LeafNode | BranchNode;

/** Rows rendered per page of children; the rest sit behind a "show more" button. */
export const PAGE_SIZE = 100;
/** Longest text a non-string leaf may display (mirrors the existing "Copy Value" limit). */
const LEAF_MAX = 10_000;

export function nextVisible(shown: number, total: number): number {
  return Math.min(total, shown + PAGE_SIZE);
}

const leaf = (cls: LeafClass, text: string): LeafNode => ({ kind: 'leaf', cls, text });

function lazy<T>(build: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= build());
}

function branch(
  shape: BranchNode['shape'],
  summary: string,
  size: number,
  omitted: number,
  build: () => readonly TreeEntry[]
): BranchNode {
  return { kind: 'branch', shape, summary, size, omitted, children: lazy(build) };
}

/** An object key as the existing detail view shows it: JSON-quoted, so odd keys stay unambiguous. */
const keyLabel = (key: string): string => JSON.stringify(key);

export function fromSerialized(value: SerializedValue): TreeNode {
  switch (value.k) {
    case 'string':
      return leaf('string', `${JSON.stringify(value.v)}${value.truncated ? '…' : ''}`);
    case 'number':
      return leaf('number', preview(value, { maxLength: LEAF_MAX, depth: 0 }));
    case 'boolean':
      return leaf('boolean', preview(value, { maxLength: LEAF_MAX, depth: 0 }));
    case 'null':
      return leaf('null', 'null');
    case 'undefined':
      return leaf('undefined', 'undefined');
    case 'array':
    case 'set': {
      const total = value.k === 'array' ? value.length : value.size;
      const omitted = Math.max(0, total - value.entries.length);
      const name = value.k === 'array' ? 'Array' : 'Set';
      if (value.entries.length === 0 && omitted === 0) {
        return leaf('empty', value.k === 'array' ? '[]' : 'Set(0) {}');
      }
      return branch(value.k, `${name}(${total})`, value.entries.length, omitted, () =>
        value.entries.map((entry, index) => ({ label: String(index), node: fromSerialized(entry) }))
      );
    }
    case 'object': {
      const omitted = Math.max(0, value.size - value.entries.length);
      const ctor = value.ctor ? `${value.ctor} ` : '';
      if (value.entries.length === 0 && omitted === 0) {
        return leaf('empty', `${ctor}{}`);
      }
      return branch('object', `${value.ctor ?? 'Object'} {${value.size}}`, value.entries.length, omitted, () =>
        value.entries.map(([key, entry]) => ({ label: keyLabel(key), node: fromSerialized(entry) }))
      );
    }
    case 'map': {
      const omitted = Math.max(0, value.size - value.entries.length);
      if (value.entries.length === 0 && omitted === 0) {
        return leaf('empty', 'Map(0) {}');
      }
      return branch('map', `Map(${value.size})`, value.entries.length, omitted, () =>
        value.entries.map(([key, entry]) => ({
          label: preview(key, { maxLength: 60, depth: 1 }),
          node: fromSerialized(entry)
        }))
      );
    }
    default:
      // Dates, functions, errors, circular references, `maxdepth` markers, ...: the
      // extension's own one-line rendering, so nothing is reworded or lost.
      return leaf('other', preview(value, { maxLength: LEAF_MAX, depth: 0 }));
  }
}

export function fromJson(value: JsonValue): TreeNode {
  switch (value.t) {
    case 'string':
      return leaf('string', JSON.stringify(value.v));
    case 'number':
      return leaf('number', value.raw);
    case 'boolean':
      return leaf('boolean', String(value.v));
    case 'null':
      return leaf('null', 'null');
    case 'array':
      return value.items.length === 0
        ? leaf('empty', '[]')
        : branch('array', `Array(${value.items.length})`, value.items.length, 0, () =>
            value.items.map((item, index) => ({ label: String(index), node: fromJson(item) }))
          );
    case 'object':
      return value.entries.length === 0
        ? leaf('empty', '{}')
        : branch('object', `Object {${value.entries.length}}`, value.entries.length, 0, () =>
            value.entries.map(([key, item]) => ({ label: keyLabel(key), node: fromJson(item) }))
          );
  }
}

// ------------------------------------------------------------ detail plan

/** One piece of the detail pane: ordinary text, or an expandable tree. */
export type DetailBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tree'; readonly root: TreeNode; readonly fromText: boolean };

/** Could this value be shown as a tree? (Cheap; parses nothing.) */
export function isTreeCandidate(value: SerializedValue): boolean {
  switch (value.k) {
    case 'array':
    case 'object':
    case 'map':
    case 'set':
      return true;
    case 'string':
      // A truncated string is cut mid-document, so it can never be valid JSON.
      return !value.truncated && looksLikeJsonContainer(value.v);
    default:
      return false;
  }
}

/**
 * Host side: the structured form of an event's values, or `undefined` when no
 * value could be a tree. Ordinary logs (strings, numbers, errors, ...) return
 * `undefined`, so their detail message is byte-for-byte what it always was.
 */
export function structuredDetailOf(event: RuntimeEvent): { values: SerializedValue[]; expr?: string } | undefined {
  if (event.t === 'log') {
    return event.args.some(isTreeCandidate) ? { values: event.args } : undefined;
  }
  if (event.t === 'expr') {
    return isTreeCandidate(event.value) ? { values: [event.value], expr: event.expr } : undefined;
  }
  return undefined;
}

function treeFor(value: SerializedValue): { root: TreeNode; fromText: boolean } | undefined {
  if (value.k === 'string') {
    if (!isTreeCandidate(value)) {
      return undefined;
    }
    const parsed = parseJsonText(value.v);
    return parsed ? { root: fromJson(parsed), fromText: true } : undefined;
  }
  return isTreeCandidate(value) ? { root: fromSerialized(value), fromText: false } : undefined;
}

/**
 * Webview side: decide how to lay out the detail pane. `undefined` means "use
 * the plain-text pane exactly as before": there are no structured values, none
 * is a tree candidate, or no JSON-looking string actually parsed.
 *
 * Values that are not trees keep the existing text form (`toPlainText`) and
 * adjacent ones are merged with a newline, which is how the plain pane has
 * always joined them.
 */
export function planDetail(detail: Pick<DetailMessage, 'values' | 'expr'>): readonly DetailBlock[] | undefined {
  const { values } = detail;
  if (!values || !values.some(isTreeCandidate)) {
    return undefined;
  }
  const blocks: DetailBlock[] = [];
  const pushText = (text: string): void => {
    const last = blocks[blocks.length - 1];
    if (last && last.kind === 'text') {
      blocks[blocks.length - 1] = { kind: 'text', text: `${last.text}\n${text}` };
    } else {
      blocks.push({ kind: 'text', text });
    }
  };
  if (detail.expr !== undefined) {
    pushText(`${detail.expr} =`);
  }
  let trees = 0;
  for (const value of values) {
    const tree = treeFor(value);
    if (tree) {
      blocks.push({ kind: 'tree', ...tree });
      trees++;
    } else {
      pushText(toPlainText(value));
    }
  }
  return trees > 0 ? blocks : undefined;
}

// ------------------------------------------------------------ in-value search

/** Tree nodes visited per search. Past this the count is a lower bound (`complete: false`). */
export const SEARCH_NODE_BUDGET = 20_000;

export interface DetailSearch {
  /** Occurrences of the query in the whole value, including inside collapsed nodes. */
  readonly count: number;
  /** False when the node budget ran out, so `count` is a lower bound. */
  readonly complete: boolean;
  /** Branches with a match somewhere below them: the ones to open so every match is visible. */
  readonly open: ReadonlySet<TreeNode>;
  /** Every node that matches itself (its key or value) or contains a match. */
  readonly hits: ReadonlySet<TreeNode>;
}

interface Frame {
  node: BranchNode;
  entries: readonly TreeEntry[];
  next: number;
  hit: boolean;
}

/**
 * Search one selected value (the "inspect" search box). It walks the tree once,
 * iteratively and within `SEARCH_NODE_BUDGET`, so a hostile or huge payload can
 * neither overflow the stack nor stall the Webview. It runs per query change
 * for the one selected value, never for the event history.
 */
export function searchDetail(
  plainText: string,
  blocks: readonly DetailBlock[] | undefined,
  matcher: Matcher,
  budget = SEARCH_NODE_BUDGET
): DetailSearch {
  const open = new Set<TreeNode>();
  const hits = new Set<TreeNode>();
  if (!blocks) {
    return { count: countMatches(plainText, matcher), complete: true, open, hits };
  }
  let count = 0;
  let visited = 0;
  let complete = true;

  for (const block of blocks) {
    if (block.kind === 'text') {
      count += countMatches(block.text, matcher);
      continue;
    }
    const root = block.root;
    if (root.kind === 'leaf') {
      const n = countMatches(root.text, matcher);
      if (n > 0) {
        count += n;
        hits.add(root);
      }
      continue;
    }
    const frames: Frame[] = [{ node: root, entries: root.children(), next: 0, hit: false }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.next >= frame.entries.length || !complete) {
        frames.pop();
        if (frame.hit) {
          open.add(frame.node);
          hits.add(frame.node);
          if (frames.length > 0) {
            frames[frames.length - 1].hit = true;
          }
        }
        continue;
      }
      const entry = frame.entries[frame.next++];
      if (++visited > budget) {
        complete = false;
        continue;
      }
      const own = countMatches(entry.label, matcher) + (entry.node.kind === 'leaf' ? countMatches(entry.node.text, matcher) : 0);
      if (own > 0) {
        count += own;
        frame.hit = true;
        hits.add(entry.node);
      }
      if (entry.node.kind === 'branch') {
        frames.push({ node: entry.node, entries: entry.node.children(), next: 0, hit: false });
      }
    }
  }
  return { count, complete, open, hits };
}

// -------------------------------------------------------------- expand all

/** Rows "Expand all" may open in one go; deeper levels stay collapsed beyond it. */
export const EXPAND_ALL_ROW_BUDGET = 2_000;

export interface ExpandAllPlan {
  /** Branches to open. The root is always included. */
  readonly open: ReadonlySet<TreeNode>;
  /** False when the row budget stopped it, leaving the deepest levels collapsed. */
  readonly complete: boolean;
}

/**
 * Which branches "Expand all" should open. Breadth-first, so when the budget
 * runs out it is the deepest levels that stay collapsed, and iterative, so a
 * very deep structure cannot overflow the stack. Only the first page of each
 * container counts (the rest sits behind "Show more", as it always has).
 * "Collapse all" needs no plan: it is an empty set.
 */
export function planExpandAll(root: TreeNode, budget = EXPAND_ALL_ROW_BUDGET): ExpandAllPlan {
  const open = new Set<TreeNode>();
  if (root.kind === 'leaf') {
    return { open, complete: true };
  }
  let rows = 0;
  let complete = true;
  const queue: BranchNode[] = [root];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    const entries = node.children();
    const shown = Math.min(entries.length, PAGE_SIZE);
    if (node !== root && rows + shown > budget) {
      complete = false;
      break;
    }
    open.add(node);
    rows += shown;
    for (let i = 0; i < shown; i++) {
      const child = entries[i].node;
      if (child.kind === 'branch') {
        queue.push(child);
      }
    }
  }
  return { open, complete };
}
