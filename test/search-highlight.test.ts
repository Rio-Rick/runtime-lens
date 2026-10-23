import assert from 'node:assert/strict';
import { MAX_HIGHLIGHTS, countMatches, createMatcher, splitByMatches } from '../src/webview/search-highlight';

/** Highlighted pieces only, in order. */
function matches(text: string, query: string): string[] {
  return splitByMatches(text, createMatcher(query)).filter((s) => s.match).map((s) => s.text);
}

/** The segments must always spell the original text back, whatever the query. */
function assertLossless(text: string, query: string): void {
  const joined = splitByMatches(text, createMatcher(query)).map((s) => s.text).join('');
  assert.equal(joined, text);
}

describe('webview/search-highlight', () => {
  describe('createMatcher', () => {
    it('returns undefined for an empty query, meaning "no highlighting"', () => {
      assert.equal(createMatcher(''), undefined);
    });

    it('keeps the literal query', () => {
      assert.equal(createMatcher('abc')?.query, 'abc');
    });
  });

  describe('splitByMatches', () => {
    it('returns the text untouched when there is no matcher', () => {
      assert.deepEqual(splitByMatches('hello', undefined), [{ text: 'hello', match: false }]);
    });

    it('returns one plain segment when nothing matches (no false highlights)', () => {
      assert.deepEqual(splitByMatches('hello world', createMatcher('xyz')), [{ text: 'hello world', match: false }]);
    });

    it('handles empty text', () => {
      assert.deepEqual(splitByMatches('', createMatcher('a')), [{ text: '', match: false }]);
    });

    it('highlights an exact match and leaves the rest plain', () => {
      assert.deepEqual(splitByMatches('user created', createMatcher('created')), [
        { text: 'user ', match: false },
        { text: 'created', match: true }
      ]);
    });

    it('highlights a partial match inside a longer word', () => {
      assert.deepEqual(matches('serializer', 'ializ'), ['ializ']);
    });

    it('is case-insensitive but shows the original casing', () => {
      assert.deepEqual(matches('Error: ERROR error', 'error'), ['Error', 'ERROR', 'error']);
    });

    it('finds multiple matches in one string', () => {
      assert.deepEqual(splitByMatches('a-b-a-b', createMatcher('b')), [
        { text: 'a-', match: false },
        { text: 'b', match: true },
        { text: '-a-', match: false },
        { text: 'b', match: true }
      ]);
    });

    it('does not overlap matches (consistent with a substring scan)', () => {
      assert.deepEqual(matches('aaaa', 'aa'), ['aa', 'aa']);
      assert.deepEqual(matches('aaa', 'aa'), ['aa']);
    });

    it('can highlight the entire text when it is the match', () => {
      assert.deepEqual(splitByMatches('ok', createMatcher('OK')), [{ text: 'ok', match: true }]);
    });

    it('matches a query at the very start and very end', () => {
      assert.deepEqual(splitByMatches('abXab', createMatcher('ab')).map((s) => s.match), [true, false, true]);
    });

    it('matches non-ASCII letters case-insensitively', () => {
      assert.deepEqual(matches('Straße ÄÖÜ äöü', 'äöü'), ['ÄÖÜ', 'äöü']);
    });
  });

  describe('special characters are literal, never a pattern', () => {
    // [name, text, query, exactly the pieces that must be highlighted]
    const cases: Array<[string, string, string, string[]]> = [
      ['a dot (not "any character")', 'file.ts and fileXts', '.', ['.']],
      ['a star', 'a*b and aab', '*', ['*']],
      ['a plus', '1+1=2', '+', ['+']],
      ['a question mark', 'what?', '?', ['?']],
      ['a caret', 'a^b', '^', ['^']],
      ['a dollar sign', 'cost $5', '$', ['$']],
      ['a replacement token', 'x $& y', '$&', ['$&']],
      ['an opening parenthesis', 'fn(a, b)', '(', ['(']],
      ['a closing parenthesis', 'fn(a, b)', ')', [')']],
      ['square brackets', 'arr[0] = [1, 2]', '[', ['[', '[']],
      ['a whole bracketed array', 'arr[0] = [1, 2]', '[1, 2]', ['[1, 2]']],
      ['curly braces', '{ a: 1 }', '{', ['{']],
      ['a pipe', 'a|b', '|', ['|']],
      ['backslashes', 'C:\\temp\\x', '\\', ['\\', '\\']],
      ['regexp-looking text', 'matches [a-z]+ here', '[a-z]+', ['[a-z]+']],
      ['an escape-looking sequence', 'id 12 and \\d', '\\d', ['\\d']],
      ['double quotes', 'say "hi"', '"', ['"', '"']],
      ['single quotes', "it's 'x'", "'x'", ["'x'"]],
      ['a quoted JSON key', '{"name":"Ada"}', '"name"', ['"name"']],
      ['backticks', 'use `code`', '`code`', ['`code`']],
      ['a slash', 'a/b', '/', ['/']]
    ];
    for (const [name, text, query, expected] of cases) {
      it(`treats ${name} literally`, () => {
        assert.deepEqual(matches(text, query), expected);
        assertLossless(text, query);
      });
    }

    it('does not let "." match any character', () => {
      assert.deepEqual(matches('abc a.c', 'a.c'), ['a.c']);
    });

    it('does not let ".*" match everything', () => {
      assert.deepEqual(matches('anything at all', '.*'), []);
    });

    it('does not let an unbalanced pattern throw', () => {
      for (const query of ['(', ')', '[', ']', '{', '}', '\\', '*', '+', '?', '|', '(?<', '[a-', 'a{1,']) {
        assert.doesNotThrow(() => createMatcher(query), `query ${JSON.stringify(query)}`);
        assertLossless('some (text) [with] {stuff} \\ * + ? |', query);
      }
    });

    it('does not interpret a query as an alternation', () => {
      assert.deepEqual(matches('cat dog', 'cat|dog'), []);
    });

    it('stays linear on a pathological query', () => {
      const text = 'a'.repeat(100_000);
      const started = Date.now();
      assert.deepEqual(matches(text, `${'a?'.repeat(25)}${'a'.repeat(25)}!`), []);
      assert.ok(Date.now() - started < 2_000);
    });
  });

  describe('integrity', () => {
    it('always reassembles to exactly the original text', () => {
      const texts = ['{"a":[1,2,{"b":"c"}]}', "it's \"quoted\"", 'line1\nline2\ttabbed', '日本語 emoji 😀 mix', '   '];
      const queries = ['a', '"', ' ', 'line', '😀', 'xyz', '{', '日'];
      for (const text of texts) {
        for (const query of queries) {
          assertLossless(text, query);
        }
      }
    });

    it('matches an emoji query as one unit', () => {
      assert.deepEqual(matches('ok 😀 ok', '😀'), ['😀']);
    });

    it('treats a whitespace-only query literally, like the host filter does', () => {
      assert.deepEqual(matches('a b  c', '  '), ['  ']);
    });

    it('gives identical results when the same matcher is reused (no lastIndex leak)', () => {
      const matcher = createMatcher('a');
      const first = splitByMatches('banana', matcher);
      const second = splitByMatches('banana', matcher);
      const other = splitByMatches('aaa', matcher);
      assert.deepEqual(second, first);
      assert.equal(other.filter((s) => s.match).length, 3);
      assert.deepEqual(splitByMatches('banana', matcher), first);
    });

    it('can be reused after a call that stopped early at the highlight cap', () => {
      // The cap leaves the shared pattern mid-string; the next call must still start at 0.
      const matcher = createMatcher('x');
      splitByMatches('x'.repeat(MAX_HIGHLIGHTS * 3), matcher);
      assert.deepEqual(splitByMatches('xx', matcher).filter((s) => s.match).map((s) => s.text), ['x', 'x']);
      assert.deepEqual(splitByMatches('x', matcher), [{ text: 'x', match: true }]);
    });

    it('caps the number of highlighted matches and still reassembles the text', () => {
      const text = 'x'.repeat(MAX_HIGHLIGHTS * 3);
      const segments = splitByMatches(text, createMatcher('x'));
      assert.equal(segments.filter((s) => s.match).length, MAX_HIGHLIGHTS);
      assert.equal(segments.map((s) => s.text).join(''), text);
      assert.equal(segments[segments.length - 1].match, false);
    });

    it('does not cap below the limit', () => {
      const text = 'x'.repeat(MAX_HIGHLIGHTS);
      assert.equal(splitByMatches(text, createMatcher('x')).filter((s) => s.match).length, MAX_HIGHLIGHTS);
    });

    it('is fast on a large string', () => {
      const text = 'lorem ipsum dolor sit amet '.repeat(40_000);
      const started = Date.now();
      splitByMatches(text, createMatcher('dolor'));
      assert.ok(Date.now() - started < 1_000);
    });
  });

  describe('countMatches', () => {
    it('counts non-overlapping, case-insensitive literal occurrences', () => {
      assert.equal(countMatches('Aa aA aaa', createMatcher('aa')), 3);
      assert.equal(countMatches('a.b a.b axb', createMatcher('a.b')), 2);
    });

    it('is zero for no matcher, empty text or no match', () => {
      assert.equal(countMatches('abc', undefined), 0);
      assert.equal(countMatches('', createMatcher('a')), 0);
      assert.equal(countMatches('abc', createMatcher('z')), 0);
    });

    it('is not capped like the highlights, and leaves the shared matcher reusable', () => {
      const matcher = createMatcher('x');
      assert.equal(countMatches('x'.repeat(MAX_HIGHLIGHTS * 3), matcher), MAX_HIGHLIGHTS * 3);
      assert.equal(countMatches('xx', matcher), 2);
    });
  });
});
