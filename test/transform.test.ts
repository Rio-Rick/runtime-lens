import assert from 'node:assert/strict';
import * as path from 'node:path';
import { INSTRUMENTED_MARKER, instrument, parserPluginsFor } from '../src/instrumentation/transform';
import { computeProbeId } from '../src/utils/probe-id';
import { shouldInstrument } from '../src/utils/paths';

const AGENT = '/ext/out/src/agent/node-agent.js';
const ROOT = '/project';

function run(code: string, file: string, extra: Record<string, unknown> = {}) {
  return instrument(code, { filename: file, agentModule: AGENT, projectRoot: ROOT, ...extra });
}

describe('instrumentation/transform', () => {
  it('parses and rewrites plain CommonJS JavaScript', () => {
    const result = run(
      `'use strict';\nconst x = 1;\nconsole.log('x is', x);\nmodule.exports = { x };\n`,
      path.join(ROOT, 'src/a.js')
    );
    assert.equal(result.skipped, false);
    assert.equal(result.probes.length, 1);
    assert.equal(result.probes[0].kind, 'log');
    assert.equal(result.probes[0].level, 'log');
    assert.equal(result.probes[0].line, 3);
    assert.match(result.code, /require\("\/ext\/out\/src\/agent\/node-agent\.js"\)/);
    assert.match(result.code, /\.c\("log", "[0-9a-f]{12}", _rlFile, 3, 0, \['x is', x\]\)/);
    assert.ok(!/console\.log/.test(result.code), 'original console.log call must be gone');
  });

  it('emits an ESM import for module sources', () => {
    const result = run(`export const a = 1;\nconsole.info('a', a);\n`, path.join(ROOT, 'src/b.mjs'));
    assert.match(result.code, /import _rlAgent from "\/ext\/out\/src\/agent\/node-agent\.js";/);
    assert.equal(result.probes[0].level, 'info');
  });

  it('handles every captured console level and multi-arg calls', () => {
    const code = [
      "console.log('a', 1, true, null, undefined);",
      "console.info('b');",
      "console.warn('c');",
      "console.error('d');",
      "console.debug('e');",
      'console.table([{ a: 1 }]);',
      'console.trace("not captured");'
    ].join('\n');
    const result = run(code, path.join(ROOT, 'levels.js'));
    assert.deepEqual(
      result.probes.map((p) => p.level),
      ['log', 'info', 'warn', 'error', 'debug', 'table']
    );
    assert.match(result.code, /console\.trace\("not captured"\)/, 'console.trace stays untouched');
  });

  it('parses TypeScript and preserves types when not stripping', () => {
    const code = `interface P { id: string }\nconst p: P = { id: 'x' };\nconsole.log('p', p satisfies P);\nexport type Q = P | null;\n`;
    const result = run(code, path.join(ROOT, 'src/t.ts'));
    assert.equal(result.skipped, false);
    assert.match(result.code, /interface P/);
    assert.match(result.code, /const p: P/);
  });

  it('strips TypeScript when asked (Node hook mode)', () => {
    const code = `const n: number = 41;\nenum E { A = 'a' }\nconsole.log('n', n, E.A);\n`;
    const result = run(code, path.join(ROOT, 'src/t2.ts'), { stripTypes: true, moduleKind: 'cjs' });
    assert.equal(result.skipped, false);
    assert.ok(!/: number/.test(result.code), 'type annotation should be gone');
    assert.match(result.code, /var E/);
  });

  it('parses JSX (.jsx) without touching markup', () => {
    const code = `export function A() {\n  console.log('render');\n  return <div className="x">console.log(\`nope\`)</div>;\n}\n`;
    const result = run(code, path.join(ROOT, 'src/A.jsx'));
    assert.equal(result.probes.length, 1);
    assert.match(result.code, /<div className="x">/);
    assert.match(result.code, /console\.log\(`nope`\)<\/div>/, 'JSX text is not code and must survive');
  });

  it('parses TSX with generics and props types', () => {
    const code = [
      "import React, { useState } from 'react';",
      'interface Props { n: number }',
      'export function C({ n }: Props): JSX.Element {',
      '  const [v, setV] = useState<number>(n);',
      "  console.log('v', v);",
      '  return <span onClick={() => setV(v + 1)}>{v}</span>;',
      '}'
    ].join('\n');
    const result = run(code, path.join(ROOT, 'src/C.tsx'));
    assert.equal(result.skipped, false);
    assert.equal(result.probes[0].line, 5);
    assert.match(result.code, /useState<number>\(n\)/);
  });

  it('never rewrites console-like text inside strings, templates or comments', () => {
    const code = [
      "const help = 'console.log(1)';",
      'const tpl = `console.error(${help})`;',
      '// console.warn("in a comment")',
      '/* console.debug("block") */',
      "console.log('real', help, tpl);"
    ].join('\n');
    const result = run(code, path.join(ROOT, 'strings.js'));
    assert.equal(result.probes.length, 1, 'exactly one real call');
    assert.match(result.code, /const help = 'console\.log\(1\)'/);
    assert.match(result.code, /console\.warn\("in a comment"\)/);
    assert.match(result.code, /console\.debug\("block"\)/);
  });

  it('respects a shadowed console binding', () => {
    const code = [
      'function f() {',
      '  const console = { log() {} };',
      "  console.log('shadowed');",
      '}',
      "console.log('global');"
    ].join('\n');
    const result = run(code, path.join(ROOT, 'shadow.js'));
    assert.equal(result.probes.length, 1);
    assert.equal(result.probes[0].line, 5);
  });

  it('captures `// ?` expression probes on statements, declarations and returns', () => {
    const code = [
      'const user = { name: "ada" };',
      'user.name; // ?',
      'const n = 1 + 2; // ?',
      'function f() {',
      '  return n * 2; // ?',
      '}',
      'f();'
    ].join('\n');
    const result = run(code, path.join(ROOT, 'probes.js'));
    assert.equal(result.probes.length, 3);
    assert.deepEqual(
      result.probes.map((p) => p.line),
      [2, 3, 5]
    );
    assert.match(result.code, /_rlAgent\.e\("[0-9a-f]{12}", _rlFile, 2, 0, "user\.name", user\.name\)/);
  });

  it('keeps comments and relative line positions', () => {
    const code = ['// leading comment', 'const a = 1; // trailing', '', '/* block */', "console.log('a', a);"].join('\n');
    const result = run(code, path.join(ROOT, 'comments.js'));
    assert.match(result.code, /\/\/ leading comment/);
    assert.match(result.code, /\/\/ trailing/);
    assert.match(result.code, /\/\* block \*\//);
    assert.equal(result.probes[0].line, 5, 'reported line is the original line');
  });

  it('is idempotent: an instrumented file is never instrumented twice', () => {
    const first = run(`console.log('once');\n`, path.join(ROOT, 'idem.js'));
    assert.ok(first.code.includes(INSTRUMENTED_MARKER));
    const second = instrument(first.code, { filename: path.join(ROOT, 'idem.js'), agentModule: AGENT });
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'already-instrumented');
  });

  it('refuses excluded locations', () => {
    for (const file of [
      '/project/node_modules/pkg/index.js',
      '/project/.next/server/page.js',
      '/project/dist/bundle.js',
      '/project/build/main.js',
      '/project/out/x.js',
      '/project/src/types.d.ts',
      '/project/src/vendor.min.js'
    ]) {
      assert.equal(shouldInstrument(file), false, file);
      const result = instrument(`console.log('x');`, { filename: file, agentModule: AGENT });
      assert.equal(result.skipped, true, file);
    }
    assert.equal(shouldInstrument('/project/src/app.tsx'), true);
    assert.equal(shouldInstrument('\0virtual:module'), false);
  });

  it('skips files with no capture candidates without parsing', () => {
    const result = run('export const a = 1;\n', path.join(ROOT, 'plain.ts'));
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no-candidates');
  });

  it('honours capture switches', () => {
    const code = "console.log('a');\nconst b = 2; // ?\n";
    const noConsole = run(code, path.join(ROOT, 'sw.js'), { captureConsole: false });
    assert.deepEqual(noConsole.probes.map((p) => p.kind), ['expr']);
    const noExpr = run(code, path.join(ROOT, 'sw.js'), { captureExpressions: false });
    assert.deepEqual(noExpr.probes.map((p) => p.kind), ['log']);
    const neither = run(code, path.join(ROOT, 'sw.js'), { captureConsole: false, captureExpressions: false });
    assert.equal(neither.skipped, true);
  });

  it('instruments nested console calls inside arguments', () => {
    const result = run(`console.log('outer', (() => { console.warn('inner'); return 1; })());\n`, path.join(ROOT, 'nested.js'));
    assert.equal(result.probes.length, 2);
    assert.deepEqual(result.probes.map((p) => p.level).sort(), ['log', 'warn']);
  });

  it('preserves spread arguments', () => {
    const result = run(`const xs = [1, 2];\nconsole.log('spread', ...xs);\n`, path.join(ROOT, 'spread.js'));
    assert.match(result.code, /\['spread', \.\.\.xs\]/);
  });

  it('produces stable, content-addressed probe ids', () => {
    const a = run(`console.log('same');\n`, path.join(ROOT, 'id.js'));
    const b = run(`console.log('same');\n`, path.join(ROOT, 'id.js'));
    assert.equal(a.probes[0].id, b.probes[0].id, 'same input -> same id');

    const moved = run(`\n\nconsole.log('same');\n`, path.join(ROOT, 'id.js'));
    assert.notEqual(a.probes[0].id, moved.probes[0].id, 'line participates in identity');

    const otherFile = run(`console.log('same');\n`, path.join(ROOT, 'other.js'));
    assert.notEqual(a.probes[0].id, otherFile.probes[0].id, 'file participates in identity');

    assert.notEqual(
      computeProbeId({ file: 'a.js', kind: 'log', text: "console.log('x')", line: 1 }),
      computeProbeId({ file: 'a.js', kind: 'expr', text: "console.log('x')", line: 1 }),
      'kind participates in identity'
    );
    assert.equal(
      computeProbeId({ file: 'a.js', kind: 'log', text: "console.log(   'x'  )\n", line: 1 }),
      computeProbeId({ file: 'a.js', kind: 'log', text: "console.log( 'x' )", line: 1 }),
      'runs of whitespace are normalised'
    );
  });

  it('selects parser plugins per extension', () => {
    assert.ok((parserPluginsFor('a.ts') as string[]).includes('typescript'));
    assert.ok(!(parserPluginsFor('a.ts') as string[]).includes('jsx'));
    assert.ok((parserPluginsFor('a.tsx') as string[]).includes('jsx'));
    assert.ok((parserPluginsFor('a.jsx') as string[]).includes('jsx'));
  });

  it('instruments the real fixture files', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const fixtures = path.join(__dirname, '..', '..', 'fixtures');
    const cases: Array<[string, number]> = [
      [path.join(fixtures, 'node-js', 'index.js'), 8],
      [path.join(fixtures, 'node-ts', 'src', 'index.ts'), 4],
      [path.join(fixtures, 'react-vite', 'src', 'App.tsx'), 4],
      [path.join(fixtures, 'next-pages', 'pages', 'index.tsx'), 4],
      [path.join(fixtures, 'next-app', 'app', 'counter.tsx'), 3]
    ];
    for (const [file, minProbes] of cases) {
      const source = fs.readFileSync(file, 'utf8');
      const result = instrument(source, { filename: file, agentModule: AGENT, sourceMaps: true });
      assert.equal(result.skipped, false, `${file} should be instrumented`);
      assert.ok(
        result.probes.length >= minProbes,
        `${file}: expected >= ${minProbes} probes, got ${result.probes.length}`
      );
      assert.ok(result.map, `${file}: expected a source map`);
    }
  });
});
