import type { SerializedValue } from '../protocol';

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

const TYPED_ARRAY_TAG = /^(Int|Uint|Float|BigInt|BigUint)(8|16|32|64)(Clamped)?Array$/;

function tagOf(value: object): string {
  return Object.prototype.toString.call(value).slice(8, -1);
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
  return walk(value, opts, seen, state, 0, '$');
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
    case 'bigint':
      return { k: 'bigint', v: `${value.toString()}n` };
    case 'symbol':
      return { k: 'symbol', v: value.toString() };
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
      return { k: 'function', name: name || '(anonymous)', kind: functionKind(fn), arity: safeArity(fn) };
    }
    default:
      break;
  }

  const obj = value as object;
  const existing = seen.get(obj);
  if (existing !== undefined) {
    return { k: 'circular', path: existing };
  }

  const tag = tagOf(obj);

  if (tag === 'Date') {
    const time = (obj as Date).getTime();
    return { k: 'date', v: Number.isNaN(time) ? 'Invalid Date' : new Date(time).toISOString() };
  }
  if (tag === 'RegExp') {
    return { k: 'regexp', v: String(obj) };
  }
  if (obj instanceof Error || tag === 'Error' || /Error$/.test((obj as { name?: string }).name ?? '')) {
    const err = obj as Error & Record<string, unknown>;
    const props: Record<string, SerializedValue> = {};
    seen.set(obj, path);
    for (const key of ownKeys(err)) {
      if (key === 'stack' || key === 'message' || key === 'name') {
        continue;
      }
      props[key] = walk(readProp(err, key), opts, seen, state, depth + 1, `${path}.${key}`);
    }
    seen.delete(obj);
    return {
      k: 'error',
      name: String(err.name ?? 'Error'),
      message: String(err.message ?? ''),
      stack: opts.includeStack && typeof err.stack === 'string' ? err.stack.slice(0, 8000) : undefined,
      props: Object.keys(props).length > 0 ? props : undefined
    };
  }

  if (depth >= opts.depth) {
    return { k: 'maxdepth', hint: describeShallow(obj, tag) };
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
      entries.push([key, walk(readProp(obj, key), opts, seen, state, depth + 1, `${path}.${key}`)]);
    }
    const ctor = constructorName(obj);
    return {
      k: 'object',
      ctor: ctor && ctor !== 'Object' ? ctor : undefined,
      entries,
      size: keys.length,
      truncated: keys.length > limit || undefined
    };
  } finally {
    seen.delete(obj);
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
    return new Error(`<throwing getter: ${(err as Error).message}>`);
  }
}

function readIndex(arr: unknown[], index: number): unknown {
  try {
    return arr[index];
  } catch (err) {
    return new Error(`<throwing index: ${(err as Error).message}>`);
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
