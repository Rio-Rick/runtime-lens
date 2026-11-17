import {
  MAX_SERIALIZED_HINT,
  MAX_SERIALIZED_KEY,
  MAX_SERIALIZED_NAME,
  MAX_SERIALIZED_TEXT,
  type SerializedValue
} from '../protocol';

export interface SerializeOptions {
  /** Maximum nesting depth before emitting a `maxdepth` marker. */
  depth: number;
  /** Maximum characters kept per string. */
  maxStringLength: number;
  /** Maximum entries kept per array/object/Map/Set. */
  maxEntries: number;
  /** Include `Error.stack`. */
  includeStack: boolean;
  /** Total node budget: a hard stop against pathological graphs. */
  maxNodes: number;
}

export const DEFAULT_SERIALIZE_OPTIONS: SerializeOptions = {
  depth: 3,
  maxStringLength: 10_000,
  maxEntries: 100,
  includeStack: true,
  maxNodes: 5_000
};

/**
 * Cut `text` to at most `max` characters, ending in an ellipsis when it was
 * cut. Every free-text field of a serialized value goes through this with the
 * limit `validateSerializedValue` enforces, because one over-long field gets
 * the whole batch it travels in rejected.
 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const TYPED_ARRAY_TAG = /^(Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array$/;

function tagOf(value: object): string {
  try {
    return Object.prototype.toString.call(value).slice(8, -1);
  } catch {
    return 'Object';
  }
}

function functionKind(fn: Function): 'function' | 'class' | 'arrow' {
  const src = (() => {
    try {
      return Function.prototype.toString.call(fn);
    } catch {
      return '';
    }
  })();
  if (/^\s*class[\s{]/.test(src)) {
    return 'class';
  }
  if (!/^\s*(async\s+)?function\b/.test(src) && /=>/.test(src)) {
    return 'arrow';
  }
  return 'function';
}

/**
 * Convert an arbitrary runtime value into a JSON-safe, bounded, tagged tree.
 *
 * Design rules:
 *  - Never throw. A serializer that throws inside a user's hot path is worse
 *    than useless, so every property read is guarded.
 *  - Never invoke user code beyond what is unavoidable: no `toJSON`, no
 *    getters on prototypes (own enumerable properties only), no `toString`
 *    on plain objects.
 *  - Cycles are reported with the *path* at which the value was first seen,
 *    which is far more useful in a UI than a bare `[Circular]`.
 */
export function serialize(value: unknown, options: Partial<SerializeOptions> = {}): SerializedValue {
  const opts: SerializeOptions = { ...DEFAULT_SERIALIZE_OPTIONS, ...options };
  const seen = new Map<object, string>();
  const state = { nodes: 0 };
  try {
    return walk(value, opts, seen, state, 0, '$');
  } catch (err) {
    // A hostile Proxy can still make intrinsic operations such as Map access,
    // `instanceof`, or Date methods throw despite the guards around normal
    // property reads. Never let telemetry serialization alter user code.
    return { k: 'unserializable', hint: `serialization failed: ${safeErrorMessage(err)}` };
  }
}

function walk(
  value: unknown,
  opts: SerializeOptions,
  seen: Map<object, string>,
  state: { nodes: number },
  depth: number,
  path: string
): SerializedValue {
  if (state.nodes++ > opts.maxNodes) {
    return { k: 'unserializable', hint: 'node budget exceeded' };
  }

  if (value === null) {
    return { k: 'null' };
  }

  switch (typeof value) {
    case 'undefined':
      return { k: 'undefined' };
    case 'boolean':
      return { k: 'boolean', v: value };
    case 'number':
      if (Number.isNaN(value)) {
        return { k: 'number', v: 'NaN' };
      }
      if (value === Infinity) {
        return { k: 'number', v: 'Infinity' };
      }
      if (value === -Infinity) {
        return { k: 'number', v: '-Infinity' };
      }
      return { k: 'number', v: value };
    case 'bigint': {
      const text = `${value.toString()}n`;
      // A truncated number would be a different number: say so instead.
      return text.length > MAX_SERIALIZED_TEXT
        ? { k: 'unserializable', hint: `BigInt with ${text.length - 1} digits (too large to show)` }
        : { k: 'bigint', v: text };
    }
    case 'symbol':
      return { k: 'symbol', v: clip(value.toString(), MAX_SERIALIZED_TEXT) };
    case 'string': {
      if (value.length > opts.maxStringLength) {
        return { k: 'string', v: value.slice(0, opts.maxStringLength), truncated: true, length: value.length };
      }
      return { k: 'string', v: value, length: value.length };
    }
    case 'function': {
      const fn = value as Function;
      let name = '';
      try {
        name = typeof fn.name === 'string' ? fn.name : '';
      } catch {
        name = '';
      }
      return { k: 'function', name: clip(name || '(anonymous)', MAX_SERIALIZED_NAME), kind: functionKind(fn), arity: safeArity(fn) };
    }
    default:
      break;
  }

  const obj = value as object;
  const existing = seen.get(obj);
  if (existing !== undefined) {
    return { k: 'circular', path: clip(existing, MAX_SERIALIZED_HINT) };
  }

  const tag = tagOf(obj);

  if (tag === 'Date') {
    const time = (obj as Date).getTime();
    return { k: 'date', v: Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString() };
  }
  if (tag === 'RegExp') {
    return { k: 'regexp', v: clip(String(obj), MAX_SERIALIZED_TEXT) };
  }
  if (isErrorLike(obj, tag)) {
    const err = obj as Error & Record<string, unknown>;
    const props: Record<string, SerializedValue> = {};
    seen.set(obj, path);
    let kept = 0;
    for (const key of ownKeys(err)) {
      if (key === 'stack' || key === 'message' || key === 'name') {
        continue;
      }
      if (kept++ >= opts.maxEntries) {
        break; // like every other container; also keeps `props` within what the protocol accepts
      }
      props[key] = walk(readProp(err, key), opts, seen, state, depth + 1, `${path}.${key}`);
    }
    seen.delete(obj);
    return {
      k: 'error',
      name: clip(String(err.name ?? 'Error'), MAX_SERIALIZED_NAME),
      message: clip(String(err.message ?? ''), MAX_SERIALIZED_TEXT),
      stack: opts.includeStack && typeof err.stack === 'string' ? err.stack.slice(0, 8000) : undefined,
      props: Object.keys(props).length > 0 ? props : undefined
    };
  }

  if (depth >= opts.depth) {
    return { k: 'maxdepth', hint: clip(describeShallow(obj, tag), MAX_SERIALIZED_HINT) };
  }

  seen.set(obj, path);
  try {
    if (Array.isArray(obj)) {
      const entries: SerializedValue[] = [];
      const limit = Math.min(obj.length, opts.maxEntries);
      for (let i = 0; i < limit; i++) {
        entries.push(walk(readIndex(obj, i), opts, seen, state, depth + 1, `${path}[${i}]`));
      }
      return { k: 'array', entries, length: obj.length, truncated: obj.length > limit || undefined };
    }

    if (TYPED_ARRAY_TAG.test(tag)) {
      const arr = obj as unknown as ArrayLike<number | bigint>;
      const entries: SerializedValue[] = [];
      const limit = Math.min(arr.length, opts.maxEntries);
      for (let i = 0; i < limit; i++) {
        entries.push(walk(arr[i], opts, seen, state, depth + 1, `${path}[${i}]`));
      }
      return { k: 'array', entries, length: arr.length, truncated: arr.length > limit || undefined };
    }

    if (obj instanceof Map || tag === 'Map') {
      const map = obj as Map<unknown, unknown>;
      const entries: Array<[SerializedValue, SerializedValue]> = [];
      let i = 0;
      for (const [key, val] of map) {
        if (i >= opts.maxEntries) {
          break;
        }
        entries.push([
          walk(key, opts, seen, state, depth + 1, `${path}.key(${i})`),
          walk(val, opts, seen, state, depth + 1, `${path}.get(${i})`)
        ]);
        i++;
      }
      return { k: 'map', entries, size: map.size, truncated: map.size > entries.length || undefined };
    }

    if (obj instanceof Set || tag === 'Set') {
      const set = obj as Set<unknown>;
      const entries: SerializedValue[] = [];
      let i = 0;
      for (const val of set) {
        if (i >= opts.maxEntries) {
          break;
        }
        entries.push(walk(val, opts, seen, state, depth + 1, `${path}.item(${i})`));
        i++;
      }
      return { k: 'set', entries, size: set.size, truncated: set.size > entries.length || undefined };
    }

    if (tag === 'WeakMap' || tag === 'WeakSet') {
      return { k: 'unserializable', hint: `${tag} (not enumerable)` };
    }
    if (tag === 'Promise') {
      return { k: 'unserializable', hint: 'Promise (pending state not observable synchronously)' };
    }

    const keys = ownKeys(obj);
    const limit = Math.min(keys.length, opts.maxEntries);
    const entries: Array<[string, SerializedValue]> = [];
    for (let i = 0; i < limit; i++) {
      const key = keys[i];
      entries.push([clip(key, MAX_SERIALIZED_KEY), walk(readProp(obj, key), opts, seen, state, depth + 1, `${path}.${key}`)]);
    }
    const ctor = constructorName(obj);
    return {
      k: 'object',
      ctor: ctor && ctor !== 'Object' ? clip(ctor, MAX_SERIALIZED_NAME) : undefined,
      entries,
      size: keys.length,
      truncated: keys.length > limit || undefined
    };
  } finally {
    seen.delete(obj);
  }
}

/**
 * Whether `obj` should be shown as an error. The `name` fallback exists for
 * error-like host objects whose tag is not `Error` (a `DOMException` called
 * `AbortError`), so it applies only to objects with a non-plain tag: a plain
 * `{ name: 'ValidationError', field: 'email' }` is data, not an error, and used
 * to be shown as an error with an empty message.
 */
function isErrorLike(obj: object, tag: string): boolean {
  if (obj instanceof Error || tag === 'Error') {
    return true;
  }
  if (tag === 'Object') {
    return false;
  }
  try {
    const name = (obj as { name?: unknown }).name;
    return typeof name === 'string' && /Error$/.test(name);
  } catch {
    return false;
  }
}

function safeArity(fn: Function): number {
  try {
    return typeof fn.length === 'number' ? fn.length : 0;
  } catch {
    return 0;
  }
}

function ownKeys(obj: object): string[] {
  try {
    return Object.keys(obj);
  } catch {
    return [];
  }
}

function readProp(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key];
  } catch (err) {
    return new Error(`<throwing getter: ${safeErrorMessage(err)}>`);
  }
}

function readIndex(arr: unknown[], index: number): unknown {
  try {
    return arr[index];
  } catch (err) {
    return new Error(`<throwing index: ${safeErrorMessage(err)}>`);
  }
}

function safeErrorMessage(err: unknown): string {
  try {
    if (err instanceof Error && typeof err.message === 'string') {
      return err.message.slice(0, 500);
    }
    return String(err).slice(0, 500);
  } catch {
    return 'unknown error';
  }
}

function constructorName(obj: object): string | undefined {
  try {
    const proto = Object.getPrototypeOf(obj);
    if (proto === null) {
      return 'Object(null prototype)';
    }
    const name = proto.constructor?.name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function describeShallow(obj: object, tag: string): string {
  if (Array.isArray(obj)) {
    return `Array(${obj.length})`;
  }
  if (obj instanceof Map || tag === 'Map') {
    return `Map(${(obj as Map<unknown, unknown>).size})`;
  }
  if (obj instanceof Set || tag === 'Set') {
    return `Set(${(obj as Set<unknown>).size})`;
  }
  const ctor = constructorName(obj) ?? tag;
  return `${ctor} {…}`;
}
