import assert from 'node:assert/strict';
import type { RuntimeEvent, SerializedValue } from '../src/protocol';
import { createMatcher, splitByMatches } from '../src/webview/search-highlight';
import {
  MAX_JSON_DEPTH,
  MAX_JSON_NODES,
  EXPAND_ALL_ROW_BUDGET,
  PAGE_SIZE,
  fromJson,
  fromSerialized,
  isTreeCandidate,
  looksLikeJsonContainer,
  nextVisible,
  parseJsonText,
  planDetail,
  planExpandAll,
  searchDetail,
  structuredDetailOf,
  type BranchNode,
  type DetailBlock,
  type JsonValue,
  type TreeNode
} from '../src/webview/tree-model';

// ------------------------------------------------------------------ helpers

const str = (v: string, extra: { truncated?: boolean } = {}): SerializedValue => ({ k: 'string', v, ...extra });
const num = (v: number): SerializedValue => ({ k: 'number', v });
const obj = (entries: Array<[string, SerializedValue]>, extra: { ctor?: string; size?: number } = {}): SerializedValue => ({
  k: 'object',
  entries,
  size: extra.size ?? entries.length,
  ...(extra.ctor ? { ctor: extra.ctor } : {})
});
const arr = (entries: SerializedValue[], length = entries.length): SerializedValue => ({ k: 'array', entries, length });

function branch(node: TreeNode): BranchNode {
  assert.equal(node.kind, 'branch');
  return node as BranchNode;
}

function treeBlocks(blocks: readonly DetailBlock[] | undefined): Array<Extract<DetailBlock, { kind: 'tree' }>> {
  assert.ok(blocks, 'expected a detail plan');
  return blocks.filter((b): b is Extract<DetailBlock, { kind: 'tree' }> => b.kind === 'tree');
}

/** Rebuild a plain JS value from a parsed JSON tree, as `JSON.parse` would have made it. */
function toPlain(value: JsonValue): unknown {
  switch (value.t) {
    case 'string':
      return value.v;
    case 'number':
      return Number(value.raw);
    case 'boolean':
      return value.v;
    case 'null':
      return null;
    case 'array':
      return value.items.map(toPlain);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.entries) {
        // defineProperty: a `__proto__` key must become an own property, as in JSON.parse.
        Object.defineProperty(out, key, { value: toPlain(item), enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
  }
}

/** Expand every node, returning how many were visited (iterative: no recursion limit). */
function countNodes(root: TreeNode): number {
  let count = 0;
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TreeNode;
    count++;
    if (node.kind === 'branch') {
      for (const entry of node.children()) {
        stack.push(entry.node);
      }
    }
  }
  return count;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function logEvent(args: SerializedValue[], level: 'log' | 'table' = 'log'): RuntimeEvent {
  return { t: 'log', id: 'p1', seq: 1, ts: 1, loc: { file: '/a.ts', line: 1, column: 0 }, count: 1, level, args };
}

// -------------------------------------------------------------------- tests

describe('webview/tree-model', () => {
  describe('looksLikeJsonContainer', () => {
    it('accepts objects and arrays, ignoring surrounding JSON whitespace', () => {
      assert.equal(looksLikeJsonContainer('{"a":1}'), true);
      assert.equal(looksLikeJsonContainer('[1,2]'), true);
      assert.equal(looksLikeJsonContainer('  \n\t{ }\r\n'), true);
      assert.equal(looksLikeJsonContainer('{}'), true);
      assert.equal(looksLikeJsonContainer('[]'), true);
    });

    it('rejects plain text, primitives, stack traces and mismatched brackets without parsing', () => {
      for (const text of [
        '',
        'a',
        'hello world',
        '42',
        'true',
        '"quoted"',
        'Error: boom\n    at foo (/a.js:1:1)',
        '{not closed',
        'closed}',
        '[1, 2}',
        '{1, 2]',
        'prefix {"a":1}',
        '{"a":1} suffix'
      ]) {
        assert.equal(looksLikeJsonContainer(text), false, JSON.stringify(text));
      }
    });
  });

  describe('parseJsonText', () => {
    it('parses objects, arrays, nesting, strings, numbers, booleans and null', () => {
      const parsed = parseJsonText('{"a":[1,true,null,"x",{"b":[]}],"c":{}}');
      assert.deepEqual(toPlain(parsed as JsonValue), { a: [1, true, null, 'x', { b: [] }], c: {} });
    });

    it('parses empty containers', () => {
      assert.deepEqual(parseJsonText('{}'), { t: 'object', entries: [] });
      assert.deepEqual(parseJsonText(' [ ] '), { t: 'array', items: [] });
    });

    it('parses top-level primitives (the tree decides whether to show them)', () => {
      assert.deepEqual(parseJsonText('42'), { t: 'number', raw: '42' });
      assert.deepEqual(parseJsonText('null'), { t: 'null' });
      assert.deepEqual(parseJsonText('"x"'), { t: 'string', v: 'x' });
    });

    it('keeps number literals verbatim instead of rounding them', () => {
      const parsed = parseJsonText('[12345678901234567890, 1.0, 1e5, -0, 0.10, 1E+2, 9007199254740993]');
      const raws = (parsed as Extract<JsonValue, { t: 'array' }>).items.map((i) => (i as Extract<JsonValue, { t: 'number' }>).raw);
      assert.deepEqual(raws, ['12345678901234567890', '1.0', '1e5', '-0', '0.10', '1E+2', '9007199254740993']);
      // JSON.parse would have silently changed the first and last of these:
      assert.notEqual(String(JSON.parse('12345678901234567890')), '12345678901234567890');
    });

    it('keeps duplicate keys, in order', () => {
      const parsed = parseJsonText('{"a":1,"a":2}') as Extract<JsonValue, { t: 'object' }>;
      assert.deepEqual(parsed.entries.map(([k, v]) => [k, (v as { raw: string }).raw]), [['a', '1'], ['a', '2']]);
    });

    it('treats a __proto__ key as plain data', () => {
      const parsed = parseJsonText('{"__proto__":{"polluted":true}}') as Extract<JsonValue, { t: 'object' }>;
      assert.equal(parsed.entries[0][0], '__proto__');
      assert.equal(({} as Record<string, unknown>).polluted, undefined);
    });

    it('decodes every escape, including unicode escapes and lone surrogates', () => {
      const text = '"\\" \\\\ \\/ \\b \\f \\n \\r \\t \\u0041 \\u00e9 \\ud83d\\ude00 \\ud800"';
      assert.equal((parseJsonText(text) as { v: string }).v, JSON.parse(text));
    });

    it('rejects invalid documents', () => {
      for (const text of [
        '',
        ' ',
        '{',
        '}',
        '[',
        '[1,]',
        '[,1]',
        '[1 2]',
        '{"a":1,}',
        '{"a" 1}',
        '{a:1}',
        "{'a':1}",
        '{"a":}',
        '{"a":1 "b":2}',
        '[01]',
        '[1.]',
        '[.5]',
        '[+1]',
        '[1e]',
        '[0x10]',
        '[NaN]',
        '[Infinity]',
        '[undefined]',
        '["unterminated]',
        '["bad \\x escape"]',
        '["bad \\u12 escape"]',
        '["raw\ttab"]',
        '["raw\nnewline"]',
        '[1] [2]',
        '[1] x',
        '// c\n[1]',
        '[1 /* c */]',
        '\ufeff[1]',
        '[tru]',
        '[truee]',
        '{"a":1}}',
        '[[1]'
      ]) {
        assert.equal(parseJsonText(text), undefined, JSON.stringify(text));
      }
    });

    it('agrees with JSON.parse on a corpus of valid and invalid documents', () => {
      const corpus = [
        '{"a":1}',
        '[1,2,3]',
        '  {"a" : [ 1 , 2 ] }  ',
        '{"k":"v\\u0000w"}',
        '[-1.5e-3, 0, -0, 1e+10]',
        '{"nested":{"deep":{"er":[{"x":null}]}}}',
        '["\u2028\u2029"]',
        '[1,]',
        '{"a":undefined}',
        "['x']",
        '[1 2]'
      ];
      for (const text of corpus) {
        let expected: unknown;
        let valid = true;
        try {
          expected = JSON.parse(text);
        } catch {
          valid = false;
        }
        const actual = parseJsonText(text);
        assert.equal(actual !== undefined, valid, JSON.stringify(text));
        if (valid) {
          assert.equal(JSON.stringify(toPlain(actual as JsonValue)), JSON.stringify(expected), JSON.stringify(text));
        }
      }
    });

    it('agrees with JSON.parse on seeded random input (accept/reject and value)', () => {
      let seed = 0x9e3779b9;
      const random = (): number => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const alphabet = ['{', '}', '[', ']', ',', ':', '"', '\\', ' ', '\n', '0', '1', '9', '.', '-', '+', 'e', 'E', 't', 'r', 'u', 'f', 'a', 'l', 's', 'n', 'x', '"a"', 'true', 'false', 'null', '\\u00e9', '\\n', '\t'];
      let accepted = 0;
      for (let i = 0; i < 6_000; i++) {
        // Half the cases are mutated *valid* documents, so acceptance is actually exercised.
        let text: string;
        if (i % 2 === 0) {
          const length = 1 + Math.floor(random() * 14);
          text = Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
        } else {
          text = JSON.stringify({ a: [1, 2.5, 'x', null, true, { b: [] }], 'k y': '\u00e9\n"' }, null, random() < 0.5 ? 2 : undefined);
          if (random() < 0.5) {
            const at = Math.floor(random() * text.length);
            text = text.slice(0, at) + alphabet[Math.floor(random() * alphabet.length)] + text.slice(at + 1);
          }
        }
        let expected: unknown;
        let valid = true;
        try {
          expected = JSON.parse(text);
        } catch {
          valid = false;
        }
        const actual = parseJsonText(text);
        assert.equal(actual !== undefined, valid, `input ${JSON.stringify(text)}`);
        if (valid) {
          accepted++;
          assert.equal(JSON.stringify(toPlain(actual as JsonValue)), JSON.stringify(expected), `input ${JSON.stringify(text)}`);
        }
      }
      assert.ok(accepted > 500, `fuzzer only produced ${accepted} valid documents`);
    });

    it('rejects nesting deeper than the limit without overflowing the stack', () => {
      const nest = (n: number): string => '['.repeat(n) + ']'.repeat(n);
      assert.notEqual(parseJsonText(nest(MAX_JSON_DEPTH)), undefined);
      assert.equal(parseJsonText(nest(MAX_JSON_DEPTH + 1)), undefined);
      assert.equal(parseJsonText(nest(200_000)), undefined);
      assert.equal(parseJsonText(`${'{"a":'.repeat(200_000)}1${'}'.repeat(200_000)}`), undefined);
    });

    it('rejects documents with too many values', () => {
      const items = (n: number): string => `[${Array.from({ length: n }, () => '1').join(',')}]`;
      assert.notEqual(parseJsonText(items(MAX_JSON_NODES - 1)), undefined);
      assert.equal(parseJsonText(items(MAX_JSON_NODES)), undefined);
    });

    it('handles a large document: parses a big one quickly, rejects one over the node cap', () => {
      const docOf = (n: number): string => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i })));
      const started = Date.now();
      // 9,000 objects = 18,001 values: under the cap.
      assert.notEqual(parseJsonText(docOf(9_000)), undefined);
      // 26,000 objects = 52,001 values (and still under the character limit): over the cap.
      const huge = docOf(26_000);
      assert.ok(huge.length < 1_000_000);
      assert.equal(parseJsonText(huge), undefined);
      assert.ok(Date.now() - started < 2_000);
    });
  });

  describe('fromSerialized', () => {
    it('shows an object as a branch with a summary and quoted keys', () => {
      const root = branch(fromSerialized(obj([['name', str('Ada')], ['age', num(36)]])));
      assert.equal(root.summary, 'Object {2}');
      assert.equal(root.shape, 'object');
      assert.deepEqual(root.children().map((e) => e.label), ['"name"', '"age"']);
      assert.deepEqual(root.children().map((e) => (e.node as { text: string }).text), ['"Ada"', '36']);
    });

    it('uses the constructor name in the summary', () => {
      assert.equal(branch(fromSerialized(obj([['id', num(1)]], { ctor: 'User' }))).summary, 'User {1}');
    });

    it('shows arrays and sets with index labels', () => {
      const array = branch(fromSerialized(arr([num(10), num(20)])));
      assert.equal(array.summary, 'Array(2)');
      assert.deepEqual(array.children().map((e) => e.label), ['0', '1']);
      const set = branch(fromSerialized({ k: 'set', entries: [str('a')], size: 1 }));
      assert.equal(set.summary, 'Set(1)');
      assert.equal(set.shape, 'set');
    });

    it('shows Map entries keyed by a preview of the key', () => {
      const map = branch(fromSerialized({ k: 'map', size: 1, entries: [[obj([['id', num(1)]]), str('v')]] }));
      assert.equal(map.summary, 'Map(1)');
      assert.equal(map.shape, 'map');
      assert.equal(map.children()[0].label, '{ id: 1 }');
    });

    it('renders empty containers as leaves, not as expandable nodes', () => {
      assert.deepEqual(fromSerialized(arr([])), { kind: 'leaf', cls: 'empty', text: '[]' });
      assert.deepEqual(fromSerialized(obj([])), { kind: 'leaf', cls: 'empty', text: '{}' });
      assert.deepEqual(fromSerialized(obj([], { ctor: 'Foo' })), { kind: 'leaf', cls: 'empty', text: 'Foo {}' });
      assert.deepEqual(fromSerialized({ k: 'map', entries: [], size: 0 }), { kind: 'leaf', cls: 'empty', text: 'Map(0) {}' });
      assert.deepEqual(fromSerialized({ k: 'set', entries: [], size: 0 }), { kind: 'leaf', cls: 'empty', text: 'Set(0) {}' });
    });

    it('keeps values JSON cannot represent exactly as the existing preview shows them', () => {
      const text = (value: SerializedValue): string => (fromSerialized(value) as { text: string }).text;
      assert.equal(text({ k: 'undefined' }), 'undefined');
      assert.equal(text({ k: 'null' }), 'null');
      assert.equal(text({ k: 'number', v: 'NaN' }), 'NaN');
      assert.equal(text({ k: 'number', v: 'Infinity' }), 'Infinity');
      assert.equal(text({ k: 'number', v: '-Infinity' }), '-Infinity');
      assert.equal(text({ k: 'bigint', v: '12345678901234567890n' }), '12345678901234567890n');
      assert.equal(text({ k: 'circular', path: '$.self' }), '[Circular → $.self]');
      assert.equal(text({ k: 'function', name: 'go', kind: 'function', arity: 2 }), 'ƒ go(2)');
      assert.equal(text({ k: 'error', name: 'TypeError', message: 'bad' }), 'TypeError: bad');
      assert.equal(text({ k: 'date', v: '2024-01-01T00:00:00.000Z' }), 'Date(2024-01-01T00:00:00.000Z)');
      assert.equal(text({ k: 'unserializable', hint: 'Proxy' }), '[Proxy]');
    });

    it('classifies leaves for styling', () => {
      const cls = (value: SerializedValue): string => (fromSerialized(value) as { cls: string }).cls;
      assert.equal(cls(str('x')), 'string');
      assert.equal(cls(num(1)), 'number');
      assert.equal(cls({ k: 'boolean', v: true }), 'boolean');
      assert.equal(cls({ k: 'null' }), 'null');
      assert.equal(cls({ k: 'undefined' }), 'undefined');
      assert.equal(cls({ k: 'circular', path: '$' }), 'other');
    });

    it('JSON-quotes strings, escaping newlines, and marks truncation', () => {
      assert.equal((fromSerialized(str('a"b\nc')) as { text: string }).text, '"a\\"b\\nc"');
      assert.equal((fromSerialized(str('cut', { truncated: true })) as { text: string }).text, '"cut"…');
    });

    it('reports what the serializer dropped instead of hiding it', () => {
      const node = branch(fromSerialized(obj([['a', num(1)]], { size: 250 })));
      assert.equal(node.size, 1);
      assert.equal(node.omitted, 249);
      assert.equal(node.summary, 'Object {250}');
      const array = branch(fromSerialized(arr([num(1), num(2)], 1_000)));
      assert.equal(array.omitted, 998);
      assert.equal(array.summary, 'Array(1000)');
    });

    it('builds children lazily and only once', () => {
      const poisoned = { k: 'array', length: 1, get entries(): SerializedValue[] { throw new Error('read too early'); } } as unknown as SerializedValue;
      const middle = arr([poisoned]);
      const root = branch(fromSerialized(obj([['middle', middle]])));
      // Making the root's children builds the middle node, which must not read the poisoned grandchild...
      const children = root.children();
      assert.equal(root.children(), children, 'children() is cached');
      // ...which only happens once the middle node is expanded.
      assert.throws(() => branch(children[0].node).children(), /read too early/);
    });

    it('survives a 10,000-level chain because only expanded levels are built', () => {
      let value: SerializedValue = num(1);
      for (let i = 0; i < 10_000; i++) {
        value = obj([['n', value]]);
      }
      let node: TreeNode = fromSerialized(value);
      let depth = 0;
      while (node.kind === 'branch') {
        node = node.children()[0].node;
        depth++;
      }
      assert.equal(depth, 10_000);
      assert.equal((node as { text: string }).text, '1');
    });

    it('handles a wide payload and never mutates its input', () => {
      const wide = deepFreeze(arr(Array.from({ length: 5_000 }, (_, i) => obj([['i', num(i)]])), 5_000));
      const root = branch(fromSerialized(wide));
      assert.equal(root.children().length, 5_000);
      assert.equal(countNodes(root), 1 + 5_000 * 2);
    });
  });

  describe('fromJson', () => {
    it('mirrors fromSerialized for the same shapes', () => {
      const root = branch(fromJson(parseJsonText('{"user":{"name":"Ada","tags":["a","b"]},"n":1.50}') as JsonValue));
      assert.equal(root.summary, 'Object {2}');
      assert.deepEqual(root.children().map((e) => e.label), ['"user"', '"n"']);
      assert.equal((root.children()[1].node as { text: string }).text, '1.50');
      const user = branch(root.children()[0].node);
      assert.equal(branch(user.children()[1].node).summary, 'Array(2)');
    });

    it('renders empty JSON containers as leaves and null/boolean verbatim', () => {
      assert.deepEqual(fromJson({ t: 'object', entries: [] }), { kind: 'leaf', cls: 'empty', text: '{}' });
      assert.deepEqual(fromJson({ t: 'array', items: [] }), { kind: 'leaf', cls: 'empty', text: '[]' });
      assert.deepEqual(fromJson({ t: 'null' }), { kind: 'leaf', cls: 'null', text: 'null' });
      assert.deepEqual(fromJson({ t: 'boolean', v: false }), { kind: 'leaf', cls: 'boolean', text: 'false' });
    });

    it('keeps a long integer exactly as written', () => {
      const root = branch(fromJson(parseJsonText('{"id":12345678901234567890}') as JsonValue));
      assert.equal((root.children()[0].node as { text: string }).text, '12345678901234567890');
    });
  });

  describe('nextVisible (paging)', () => {
    it('reveals one page at a time and never overshoots', () => {
      assert.equal(nextVisible(PAGE_SIZE, 1_000), PAGE_SIZE * 2);
      assert.equal(nextVisible(PAGE_SIZE, PAGE_SIZE + 5), PAGE_SIZE + 5);
      assert.equal(nextVisible(0, 3), 3);
    });
  });

  describe('isTreeCandidate', () => {
    it('is true for containers and JSON-looking strings only', () => {
      assert.equal(isTreeCandidate(obj([])), true);
      assert.equal(isTreeCandidate(arr([])), true);
      assert.equal(isTreeCandidate({ k: 'map', entries: [], size: 0 }), true);
      assert.equal(isTreeCandidate({ k: 'set', entries: [], size: 0 }), true);
      assert.equal(isTreeCandidate(str('{"a":1}')), true);
      assert.equal(isTreeCandidate(str('plain')), false);
      assert.equal(isTreeCandidate(num(1)), false);
      assert.equal(isTreeCandidate({ k: 'error', name: 'E', message: 'm' }), false);
      assert.equal(isTreeCandidate({ k: 'null' }), false);
    });

    it('never treats a truncated string as JSON, because it is cut mid-document', () => {
      assert.equal(isTreeCandidate(str('{"a":"long', { truncated: true })), false);
      assert.equal(isTreeCandidate(str('{"a":1}', { truncated: true })), false);
    });
  });

  describe('planDetail', () => {
    it('returns undefined without structured values, so the plain pane is used', () => {
      assert.equal(planDetail({}), undefined);
      assert.equal(planDetail({ values: [] }), undefined);
    });

    it('returns undefined for ordinary logs: strings, numbers, errors, stack traces', () => {
      assert.equal(planDetail({ values: [str('hello'), num(1)] }), undefined);
      assert.equal(planDetail({ values: [str('Error: boom\n    at f (/a.js:1:1)')] }), undefined);
      assert.equal(planDetail({ values: [{ k: 'error', name: 'E', message: 'm', stack: 'E: m\n at x' }] }), undefined);
    });

    it('returns undefined when a JSON-looking string is not valid JSON', () => {
      for (const text of ['[object Object]', '{not json}', '[1, 2', '{"a":1,}', '[1,2,]', '[Symbol(x)]', '{"a": undefined}']) {
        assert.equal(planDetail({ values: [str(text)] }), undefined, text);
      }
    });

    it('turns a valid JSON string into a tree tagged as parsed text', () => {
      const [tree] = treeBlocks(planDetail({ values: [str('{"a":[1,2],"b":{"c":null}}')] }));
      assert.equal(tree.fromText, true);
      assert.equal(branch(tree.root).summary, 'Object {2}');
    });

    it('turns a serialized object into a tree that is not tagged as text', () => {
      const [tree] = treeBlocks(planDetail({ values: [obj([['a', num(1)]])] }));
      assert.equal(tree.fromText, false);
    });

    it('keeps non-tree arguments as text, in order, merged like the plain pane joins them', () => {
      const blocks = planDetail({ values: [str('first'), str('second'), obj([['a', num(1)]]), num(7), str('{"b":2}')] }) as readonly DetailBlock[];
      assert.deepEqual(
        blocks.map((b) => b.kind),
        ['text', 'tree', 'text', 'tree']
      );
      assert.deepEqual(blocks[0], { kind: 'text', text: '"first"\n"second"' });
      assert.deepEqual(blocks[2], { kind: 'text', text: '7' });
    });

    it('puts the probed expression above its tree', () => {
      const blocks = planDetail({ expr: 'user', values: [obj([['id', num(1)]])] }) as readonly DetailBlock[];
      assert.deepEqual(blocks[0], { kind: 'text', text: 'user =' });
      assert.equal(blocks[1].kind, 'tree');
    });

    it('falls back to text for an invalid JSON-looking string next to a real object', () => {
      const blocks = planDetail({ values: [str('[broken'), obj([['a', num(1)]])] }) as readonly DetailBlock[];
      assert.deepEqual(blocks.map((b) => b.kind), ['text', 'tree']);
      assert.equal((blocks[0] as { text: string }).text, '"[broken"');
    });

    it('does not run the parser for strings that fail the cheap pre-check', () => {
      // A million-character string of plain text must be rejected in O(1), not scanned.
      const started = Date.now();
      assert.equal(planDetail({ values: [str('x'.repeat(900_000))] }), undefined);
      assert.ok(Date.now() - started < 200);
    });
  });

  describe('structuredDetailOf (host side)', () => {
    it('is undefined for ordinary logs, so their detail message is unchanged', () => {
      assert.equal(structuredDetailOf(logEvent([str('hi'), num(1)])), undefined);
      assert.equal(structuredDetailOf(logEvent([{ k: 'error', name: 'E', message: 'm' }])), undefined);
      assert.equal(structuredDetailOf(logEvent([str('plain text with {braces} inside')])), undefined);
    });

    it('carries the args when one of them can be a tree', () => {
      const args = [str('msg'), obj([['a', num(1)]])];
      assert.deepEqual(structuredDetailOf(logEvent(args)), { values: args });
      assert.deepEqual(structuredDetailOf(logEvent([str('{"a":1}')])), { values: [str('{"a":1}')] });
    });

    it('carries the probed value and expression for expr events', () => {
      const value = arr([num(1)]);
      const event: RuntimeEvent = { t: 'expr', id: 'p', seq: 1, ts: 1, loc: { file: '/a.ts', line: 1, column: 0 }, count: 1, expr: 'list', value };
      assert.deepEqual(structuredDetailOf(event), { values: [value], expr: 'list' });
      assert.equal(structuredDetailOf({ ...event, value: num(3) }), undefined);
    });

    it('is undefined for runtime errors', () => {
      const event: RuntimeEvent = { t: 'error', id: 'p', seq: 1, ts: 1, loc: { file: '/a.ts', line: 1, column: 0 }, count: 1, message: 'x', stack: 's', fatal: false };
      assert.equal(structuredDetailOf(event), undefined);
    });
  });

  describe('search highlighting over tree text', () => {
    it('highlights matches in visible keys and values', () => {
      const root = branch(fromSerialized(obj([['userName', str('Alice')], ['role', str('alice-admin')]])));
      const matcher = createMatcher('alice');
      const [first, second] = root.children();
      assert.deepEqual(splitByMatches(first.label, matcher).filter((s) => s.match), []);
      assert.deepEqual(splitByMatches((first.node as { text: string }).text, matcher).filter((s) => s.match).map((s) => s.text), ['Alice']);
      assert.deepEqual(splitByMatches((second.node as { text: string }).text, matcher).filter((s) => s.match).map((s) => s.text), ['alice']);
      assert.deepEqual(splitByMatches(first.label, createMatcher('NAME')).filter((s) => s.match).map((s) => s.text), ['Name']);
    });

    it('highlights through the JSON quotes of a key', () => {
      const root = branch(fromJson(parseJsonText('{"a.b":"[x]"}') as JsonValue));
      const [entry] = root.children();
      assert.deepEqual(splitByMatches(entry.label, createMatcher('a.b')).filter((s) => s.match).map((s) => s.text), ['a.b']);
      assert.deepEqual(splitByMatches((entry.node as { text: string }).text, createMatcher('[x]')).filter((s) => s.match).map((s) => s.text), ['[x]']);
      assert.deepEqual(splitByMatches(entry.label, createMatcher('a*b')).filter((s) => s.match), []);
    });
  });

  describe('searchDetail (inspect-pane search)', () => {
    const plan = (value: SerializedValue): readonly DetailBlock[] => planDetail({ values: [value] }) as readonly DetailBlock[];
    const sample = obj([
      ['user', obj([['name', str('Alice')], ['address', obj([['city', str('Oslo')]])]])],
      ['other', obj([['x', num(1)]])],
      ['alice_id', num(7)]
    ]);

    it('counts occurrences in plain text when there is no tree', () => {
      const result = searchDetail('Alice and alice', undefined, createMatcher('alice') as NonNullable<ReturnType<typeof createMatcher>>);
      assert.equal(result.count, 2);
      assert.equal(result.complete, true);
    });

    it('counts keys and values, including inside collapsed nodes', () => {
      const result = searchDetail('', plan(sample), createMatcher('alice') as NonNullable<ReturnType<typeof createMatcher>>);
      assert.equal(result.count, 2); // value "Alice" and key "alice_id"
    });

    it('opens exactly the ancestors of a deep match, not unrelated branches', () => {
      const blocks = plan(sample);
      const root = (blocks[0] as Extract<DetailBlock, { kind: 'tree' }>).root as BranchNode;
      const [user, other] = root.children().map((e) => e.node as BranchNode);
      const address = user.children()[1].node as BranchNode;
      const result = searchDetail('', blocks, createMatcher('oslo') as NonNullable<ReturnType<typeof createMatcher>>);
      assert.equal(result.count, 1);
      assert.ok(result.open.has(root) && result.open.has(user) && result.open.has(address));
      assert.ok(!result.open.has(other), 'a branch with no match stays closed');
      assert.ok(result.hits.has(user) && !result.hits.has(other));
    });

    it('does not open a branch whose only match is its own key', () => {
      const blocks = plan(obj([['target', obj([['a', num(1)]])], ['z', num(2)]]));
      const root = (blocks[0] as Extract<DetailBlock, { kind: 'tree' }>).root as BranchNode;
      const target = root.children()[0].node as BranchNode;
      const result = searchDetail('', blocks, createMatcher('target') as NonNullable<ReturnType<typeof createMatcher>>);
      assert.equal(result.count, 1);
      assert.ok(result.hits.has(target));
      assert.ok(!result.open.has(target), 'its children do not match, so it stays collapsed');
      assert.ok(result.open.has(root));
    });

    it('also counts matches in the text blocks around a tree', () => {
      const blocks = planDetail({ expr: 'cart', values: [obj([['cart_total', num(5)]])] }) as readonly DetailBlock[];
      assert.equal(searchDetail('', blocks, createMatcher('cart') as NonNullable<ReturnType<typeof createMatcher>>).count, 2);
    });

    it('reports no matches with empty sets', () => {
      const result = searchDetail('', plan(sample), createMatcher('zzz') as NonNullable<ReturnType<typeof createMatcher>>);
      assert.equal(result.count, 0);
      assert.equal(result.open.size, 0);
      assert.equal(result.hits.size, 0);
    });

    it('treats the query literally', () => {
      const blocks = plan(obj([['a', str('a.c')], ['b', str('abc')]]));
      assert.equal(searchDetail('', blocks, createMatcher('a.c') as NonNullable<ReturnType<typeof createMatcher>>).count, 1);
    });

    it('stops at the node budget and says the count is a lower bound', () => {
      const big = arr(Array.from({ length: 500 }, () => str('hit')), 500);
      const limited = searchDetail('', plan(big), createMatcher('hit') as NonNullable<ReturnType<typeof createMatcher>>, 100);
      assert.equal(limited.complete, false);
      assert.ok(limited.count > 0 && limited.count <= 100);
      const full = searchDetail('', plan(big), createMatcher('hit') as NonNullable<ReturnType<typeof createMatcher>>);
      assert.equal(full.complete, true);
      assert.equal(full.count, 500);
    });

    it('survives a 10,000-level chain without recursion', () => {
      let value: SerializedValue = str('needle');
      for (let i = 0; i < 10_000; i++) {
        value = obj([['n', value]]);
      }
      const result = searchDetail('', plan(value), createMatcher('needle') as NonNullable<ReturnType<typeof createMatcher>>);
      assert.equal(result.count, 1);
      assert.equal(result.open.size, 10_000);
    });
  });

  describe('planExpandAll ("Expand all")', () => {
    const rootOf = (value: SerializedValue): BranchNode => branch(fromSerialized(value));

    it('opens every branch of a small tree, root included', () => {
      const root = rootOf(obj([['a', obj([['b', arr([obj([['c', num(1)]])])]])], ['d', arr([num(1), num(2)])]]));
      const plan = planExpandAll(root);
      assert.equal(plan.complete, true);
      let branches = 0;
      const stack: TreeNode[] = [root];
      while (stack.length) {
        const node = stack.pop() as TreeNode;
        if (node.kind === 'branch') {
          branches++;
          assert.ok(plan.open.has(node), 'every branch is in the plan');
          node.children().forEach((e) => stack.push(e.node));
        }
      }
      assert.equal(plan.open.size, branches);
    });

    it('does not list leaves, and an empty plan is what "Collapse all" uses', () => {
      assert.equal(planExpandAll(fromSerialized(num(1))).open.size, 0);
      assert.equal(planExpandAll(fromSerialized(obj([]))).open.size, 0);
    });

    it('stops at the row budget and leaves the deepest levels collapsed', () => {
      // Root with 10 children, each with 10 children, each with 10 leaves: 1 + 10 + 100 branches.
      const leafy = (): SerializedValue => arr(Array.from({ length: 10 }, (_, i) => num(i)));
      const mid = (): SerializedValue => arr(Array.from({ length: 10 }, leafy));
      const tree = rootOf(arr(Array.from({ length: 10 }, mid)));
      const full = planExpandAll(tree, 10_000);
      assert.equal(full.complete, true);
      assert.equal(full.open.size, 111);
      const limited = planExpandAll(tree, 60);
      assert.equal(limited.complete, false);
      assert.ok(limited.open.has(tree), 'root is always opened');
      assert.ok(limited.open.size < 111);
      // Breadth-first: whenever a deeper branch is open, its whole parent level was opened first.
      const level1 = tree.children().map((e) => e.node as BranchNode);
      assert.ok(level1.some((n) => limited.open.has(n)));
    });

    it('always opens the root even if it alone exceeds the budget', () => {
      const plan = planExpandAll(rootOf(arr(Array.from({ length: 50 }, (_, i) => num(i)))), 1);
      assert.equal(plan.open.size, 1);
      assert.equal(plan.complete, true);
    });

    it('counts only one page of a huge container', () => {
      const wide = rootOf(arr(Array.from({ length: 5_000 }, (_, i) => arr([num(i)])), 5_000));
      const plan = planExpandAll(wide);
      assert.equal(plan.open.size, 1 + Math.min(PAGE_SIZE, 5_000), 'root plus the first page of children');
      assert.equal(plan.complete, true);
    });

    it('survives a 10,000-level chain: bounded by the row budget, flagged incomplete, no recursion', () => {
      let value: SerializedValue = num(1);
      for (let i = 0; i < 10_000; i++) {
        value = obj([['n', value]]);
      }
      const plan = planExpandAll(rootOf(value));
      assert.equal(plan.complete, false, '10,000 rows is over the budget');
      assert.equal(plan.open.size, EXPAND_ALL_ROW_BUDGET, 'one row per level, stopped exactly at the budget');
    });
  });
});
