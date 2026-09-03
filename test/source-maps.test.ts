import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceMapResolver, appendInlineSourceMap, lastSourceMappingUrl } from '../src/instrumentation/source-maps';
import { instrument } from '../src/instrumentation/transform';

const AGENT = '/ext/out/src/agent/node-agent.js';

/** In-memory fs stub so map discovery can be tested without touching disk. */
function fakeFs(files: Record<string, string>): Pick<typeof fs, 'existsSync' | 'readFileSync'> {
  return {
    existsSync: ((p: fs.PathLike) => Object.prototype.hasOwnProperty.call(files, String(p))) as typeof fs.existsSync,
    readFileSync: ((p: fs.PathLike) => {
      const key = String(p);
      if (!(key in files)) {
        throw new Error(`ENOENT: ${key}`);
      }
      return files[key];
    }) as typeof fs.readFileSync
  };
}

describe('instrumentation/source-maps', () => {
  it('remaps an instrumented TypeScript file back to its original lines', () => {
    const file = path.join(os.tmpdir(), 'rl-map', 'app.ts');
    const source = [
      '// header comment',
      'interface User { name: string }',
      '',
      'export function greet(user: User): string {',
      "  console.log('greeting', user.name);",
      '  const message = `hi ${user.name}`;',
      '  message; // ?',
      '  return message;',
      '}'
    ].join('\n');

    const result = instrument(source, {
      filename: file,
      agentModule: AGENT,
      stripTypes: true,
      moduleKind: 'cjs',
      sourceMaps: true
    });
    assert.equal(result.skipped, false);
    assert.ok(result.map, 'expected a source map');

    // Find where the generated code put the console capture call.
    const lines = result.code.split('\n');
    const genLine = lines.findIndex((l) => l.includes('.c("log"')) + 1;
    assert.ok(genLine > 0, 'generated call not found');
    const column = lines[genLine - 1].indexOf('_rlAgent');

    const resolver = new SourceMapResolver();
    resolver.registerMap(file, result.map);
    const resolved = resolver.resolve({ file, line: genLine, column });
    assert.equal(resolved.remapped, true);
    assert.equal(resolved.line, 5, `expected original line 5, got ${resolved.line}`);
    assert.ok(resolved.file.endsWith('app.ts'));
    assert.deepEqual(resolved.via?.length, 1);
  });

  it('remaps .tsx locations through a registered map', () => {
    const file = '/p/src/Widget.tsx';
    const source = [
      "import React from 'react';",
      'export function Widget({ n }: { n: number }) {',
      '  const label = `n=${n}`;',
      "  console.info('widget', label, n);",
      '  return <div>{label}</div>;',
      '}'
    ].join('\n');
    const result = instrument(source, { filename: file, agentModule: AGENT, sourceMaps: true, stripTypes: true });
    const lines = result.code.split('\n');
    const genLine = lines.findIndex((l) => l.includes('.c("info"')) + 1;
    const resolver = new SourceMapResolver();
    resolver.registerMap(file, result.map);
    const resolved = resolver.resolve({ file, line: genLine, column: lines[genLine - 1].indexOf('_rlAgent') });
    assert.equal(resolved.line, 4);
    assert.equal(resolved.remapped, true);
  });

  it('passes locations through unchanged when there is no map', () => {
    const resolver = new SourceMapResolver(4, fakeFs({}));
    const resolved = resolver.resolve({ file: '/p/plain.js', line: 12, column: 3 });
    assert.equal(resolved.remapped, false);
    assert.equal(resolved.line, 12);
    assert.equal(resolved.column, 3);
    assert.equal(resolved.via, undefined);
  });

  it('discovers an inline base64 sourceMappingURL from the generated file', () => {
    const generated = '/p/dist/bundle.js';
    const map = {
      version: 3,
      file: 'bundle.js',
      sources: ['../src/original.ts'],
      sourcesContent: [null],
      names: [],
      // maps generated 1:1 -> original line 3, column 6
      mappings: 'AAEM'
    };
    const code = appendInlineSourceMap('console.log(1);', map);
    assert.match(code, /sourceMappingURL=data:application\/json/);
    const resolver = new SourceMapResolver(4, fakeFs({ [generated]: code }));
    const resolved = resolver.resolve({ file: generated, line: 1, column: 0 });
    assert.equal(resolved.remapped, true);
    assert.equal(resolved.line, 3);
    assert.equal(resolved.column, 6);
    assert.equal(resolved.file, '/p/src/original.ts', 'relative sources resolve against the generated file');
  });

  it('discovers a sibling .map file when there is no comment', () => {
    const generated = '/p/dist/app.js';
    const map = JSON.stringify({
      version: 3,
      file: 'app.js',
      sources: ['../../src/app.tsx'],
      names: [],
      mappings: 'AACA'
    });
    const resolver = new SourceMapResolver(4, fakeFs({ [generated]: 'console.log(1);', [`${generated}.map`]: map }));
    const resolved = resolver.resolve({ file: generated, line: 1, column: 0 });
    assert.equal(resolved.remapped, true);
    assert.equal(resolved.line, 2);
    assert.equal(resolved.file, '/src/app.tsx');
  });

  it('follows a relative sourceMappingURL to a separate file', () => {
    const generated = '/p/out/x.js';
    const map = JSON.stringify({ version: 3, file: 'x.js', sources: ['x.ts'], names: [], mappings: 'AAAA' });
    const resolver = new SourceMapResolver(
      4,
      fakeFs({ [generated]: 'code();\n//# sourceMappingURL=x.js.map\n', '/p/out/x.js.map': map })
    );
    const resolved = resolver.resolve({ file: generated, line: 1, column: 0 });
    assert.equal(resolved.remapped, true);
    assert.equal(resolved.file, '/p/out/x.ts');
  });

  it('strips webpack:// prefixes from map sources', () => {
    const generated = '/p/.next/server/pages/index.js';
    const map = JSON.stringify({
      version: 3,
      sources: ['webpack:///./pages/index.tsx'],
      names: [],
      mappings: 'AAAA'
    });
    const resolver = new SourceMapResolver(4, fakeFs({ [generated]: 'x();', [`${generated}.map`]: map }));
    const resolved = resolver.resolve({ file: generated, line: 1, column: 0 });
    assert.match(resolved.file, /pages\/index\.tsx$/);
    assert.ok(!resolved.file.includes('webpack:'));
  });

  it('follows a multi-hop chain (bundle -> transpiled -> original)', () => {
    const bundle = '/p/dist/bundle.js';
    const middle = '/p/dist/middle.js';
    const bundleMap = JSON.stringify({ version: 3, sources: ['middle.js'], names: [], mappings: 'AAAA' });
    const middleMap = JSON.stringify({ version: 3, sources: ['../src/real.ts'], names: [], mappings: 'AAAA' });
    const resolver = new SourceMapResolver(
      4,
      fakeFs({
        [bundle]: 'x();',
        [`${bundle}.map`]: bundleMap,
        [middle]: 'y();',
        [`${middle}.map`]: middleMap
      })
    );
    const resolved = resolver.resolve({ file: bundle, line: 1, column: 0 });
    assert.equal(resolved.file, '/p/src/real.ts');
    assert.deepEqual(resolved.via, ['/p/dist/bundle.js', '/p/dist/middle.js']);
  });

  it('stops after maxHops on a self-referential chain', () => {
    const loop = '/p/loop.js';
    const map = JSON.stringify({ version: 3, sources: ['loop.js'], names: [], mappings: 'AAAA' });
    const resolver = new SourceMapResolver(3, fakeFs({ [loop]: 'x();', [`${loop}.map`]: map }));
    const resolved = resolver.resolve({ file: loop, line: 1, column: 0 });
    assert.equal(resolved.file, '/p/loop.js', 'a fixed point ends the walk instead of looping forever');
  });

  it('caches negative lookups and honours unregister/clear', () => {
    let reads = 0;
    const files: Record<string, string> = { '/p/a.js': 'no map here' };
    const counting: Pick<typeof fs, 'existsSync' | 'readFileSync'> = {
      existsSync: ((p: fs.PathLike) => String(p) in files) as typeof fs.existsSync,
      readFileSync: ((p: fs.PathLike) => {
        reads++;
        return files[String(p)];
      }) as typeof fs.readFileSync
    };
    const resolver = new SourceMapResolver(4, counting);
    resolver.resolve({ file: '/p/a.js', line: 1, column: 0 });
    resolver.resolve({ file: '/p/a.js', line: 2, column: 0 });
    resolver.resolve({ file: '/p/a.js', line: 3, column: 0 });
    assert.equal(reads, 1, 'a file with no map is only read once');

    const result = instrument("const y = 2;\nconsole.log('x', y);\n", {
      filename: '/p/b.js',
      agentModule: AGENT,
      sourceMaps: true
    });
    const genLines = result.code.split('\n');
    const genLine = genLines.findIndex((l) => l.includes('.c("log"')) + 1;
    const column = genLines[genLine - 1].indexOf('_rlAgent');
    resolver.registerMap('/p/b.js', result.map);
    const hit = resolver.resolve({ file: '/p/b.js', line: genLine, column });
    assert.equal(hit.remapped, true);
    assert.equal(hit.line, 2, 'the call was on original line 2');
    resolver.unregister('/p/b.js');
    assert.equal(resolver.resolve({ file: '/p/b.js', line: genLine, column }).remapped, false);
    resolver.clear();
  });

  it('ignores broken maps rather than throwing', () => {
    const resolver = new SourceMapResolver(4, fakeFs({ '/p/c.js': 'x();\n//# sourceMappingURL=data:application/json;base64,!!!not-base64' }));
    assert.doesNotThrow(() => resolver.resolve({ file: '/p/c.js', line: 1, column: 0 }));
    const r2 = new SourceMapResolver();
    r2.registerMap('/p/d.js', '{ not json');
    assert.equal(r2.resolve({ file: '/p/d.js', line: 1, column: 0 }).remapped, false);
  });

  it('lastSourceMappingUrl returns the final comment in the file', () => {
    assert.equal(lastSourceMappingUrl('a\n//# sourceMappingURL=one.map\n//# sourceMappingURL=two.map'), 'two.map');
    assert.equal(lastSourceMappingUrl('//@ sourceMappingURL=legacy.map'), 'legacy.map');
    assert.equal(lastSourceMappingUrl('no map here'), undefined);
  });

  it('appendInlineSourceMap is a no-op without a map', () => {
    assert.equal(appendInlineSourceMap('code', undefined), 'code');
    assert.match(appendInlineSourceMap('code', { version: 3 }), /base64,/);
  });
});
