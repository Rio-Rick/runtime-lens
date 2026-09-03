import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectProject, type FsLike } from '../src/framework/detect';
import { selectStrategy } from '../src/framework/strategy';

const FIXTURES = path.join(__dirname, '..', '..', 'fixtures');
const CTX = { port: 41234, token: 'tok', extensionOut: '/ext/out/src' };

/** Build an FsLike over a plain record of virtual files. */
function virtualFs(files: Record<string, string>): FsLike {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const table = Object.fromEntries(Object.entries(files).map(([k, v]) => [norm(k), v]));
  // Directories are implied by the files inside them, exactly like a real fs.
  const directories = new Set<string>();
  for (const key of Object.keys(table)) {
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join('/'));
    }
  }
  return {
    existsSync: (p: string) => {
      const key = norm(p).replace(/\/$/, '');
      return key in table || directories.has(key);
    },
    readFileSync: (p: string) => {
      const key = norm(p);
      if (!(key in table)) {
        throw new Error(`ENOENT ${key}`);
      }
      return table[key];
    },
    readdirSync: (p: string) => {
      const prefix = `${norm(p).replace(/\/$/, '')}/`;
      const names = new Set<string>();
      for (const key of Object.keys(table)) {
        if (key.startsWith(prefix)) {
          names.add(key.slice(prefix.length).split('/')[0]);
        }
      }
      return [...names];
    }
  };
}

describe('framework/detect (real fixtures)', () => {
  it('detects a CommonJS Node + Express project', () => {
    const profile = detectProject(path.join(FIXTURES, 'node-js'), fs as unknown as FsLike);
    assert.equal(profile.primary, 'express');
    assert.ok(profile.frameworks.includes('node'));
    assert.equal(profile.moduleKind, 'cjs');
    assert.equal(profile.typescript, false);
    assert.equal(profile.jsx, false);
    assert.equal(profile.entry, 'index.js');
    assert.ok(profile.configs.packageJson?.endsWith('package.json'));
    assert.equal(profile.configs.tsconfig, undefined);
  });

  it('detects an ESM TypeScript Node + Fastify project', () => {
    const profile = detectProject(path.join(FIXTURES, 'node-ts'), fs as unknown as FsLike);
    assert.equal(profile.primary, 'fastify');
    assert.equal(profile.moduleKind, 'esm');
    assert.equal(profile.typescript, true);
    assert.equal(profile.entry, 'src/index.ts');
    assert.ok(profile.configs.tsconfig?.endsWith('tsconfig.json'));
  });

  it('detects a Vite + React project and its config file', () => {
    const profile = detectProject(path.join(FIXTURES, 'react-vite'), fs as unknown as FsLike);
    assert.equal(profile.primary, 'vite');
    assert.ok(profile.frameworks.includes('react'));
    assert.equal(profile.moduleKind, 'esm');
    assert.equal(profile.typescript, true);
    assert.equal(profile.jsx, true);
    assert.ok(profile.configs.vite?.endsWith('vite.config.ts'));
    assert.equal(profile.entry, 'src/main.tsx');
  });

  it('detects a Next.js pages-router project', () => {
    const profile = detectProject(path.join(FIXTURES, 'next-pages'), fs as unknown as FsLike);
    assert.equal(profile.primary, 'next-pages');
    assert.deepEqual(profile.nextRouters, ['pages']);
    assert.ok(profile.configs.next?.endsWith('next.config.js'));
    assert.equal(profile.jsx, true);
    assert.equal(profile.typescript, true);
    assert.ok(profile.frameworks.includes('react'));
  });

  it('detects a Next.js app-router project', () => {
    const profile = detectProject(path.join(FIXTURES, 'next-app'), fs as unknown as FsLike);
    assert.equal(profile.primary, 'next-app');
    assert.deepEqual(profile.nextRouters, ['app']);
    assert.ok(profile.configs.next?.endsWith('next.config.mjs'));
    assert.equal(profile.moduleKind, 'esm');
  });
});

describe('framework/detect (synthetic layouts)', () => {
  it('detects a hybrid app+pages Next project under src/', () => {
    const profile = detectProject(
      '/w',
      virtualFs({
        '/w/package.json': JSON.stringify({ dependencies: { next: '14.0.0', react: '18.0.0' } }),
        '/w/next.config.ts': 'export default {}',
        '/w/src/app/page.tsx': 'export default function P() { return null }',
        '/w/src/pages/legacy.tsx': 'export default function L() { return null }'
      })
    );
    assert.equal(profile.primary, 'next-hybrid');
    assert.deepEqual([...profile.nextRouters].sort(), ['app', 'pages']);
  });

  it('prefers a NestJS signature over plain express', () => {
    const profile = detectProject(
      '/w',
      virtualFs({
        '/w/package.json': JSON.stringify({
          main: 'src/main.ts',
          dependencies: { '@nestjs/core': '10.0.0', express: '4.18.0' }
        }),
        '/w/src/main.ts': 'bootstrap();'
      })
    );
    assert.equal(profile.primary, 'nestjs');
    assert.ok(profile.frameworks.includes('express'));
    assert.equal(profile.typescript, true, 'a .ts entry implies TypeScript even without tsconfig');
  });

  it('reads module kind from package.json type field', () => {
    const esm = detectProject('/w', virtualFs({ '/w/package.json': JSON.stringify({ type: 'module' }) }));
    assert.equal(esm.moduleKind, 'esm');
    const cjs = detectProject('/w', virtualFs({ '/w/package.json': JSON.stringify({ type: 'commonjs' }) }));
    assert.equal(cjs.moduleKind, 'cjs');
    const implied = detectProject('/w', virtualFs({ '/w/package.json': '{}' }));
    assert.equal(implied.moduleKind, 'cjs', 'no type field means CommonJS');
  });

  it('detects jsx from jsconfig when there is no tsconfig', () => {
    const profile = detectProject(
      '/w',
      virtualFs({
        '/w/package.json': JSON.stringify({ dependencies: { react: '18.0.0' } }),
        '/w/jsconfig.json': '{\n  // trailing commas and comments are tolerated\n  "compilerOptions": { "jsx": "react-jsx", },\n}',
        '/w/webpack.config.js': 'module.exports = {}'
      })
    );
    assert.equal(profile.jsx, true);
    assert.equal(profile.typescript, false);
    assert.ok(profile.configs.jsconfig?.endsWith('jsconfig.json'));
    assert.ok(profile.frameworks.includes('webpack'));
  });

  it('picks up the package manager from the lockfile', () => {
    const base = { '/w/package.json': '{}' };
    assert.equal(detectProject('/w', virtualFs({ ...base, '/w/pnpm-lock.yaml': '' })).packageManager, 'pnpm');
    assert.equal(detectProject('/w', virtualFs({ ...base, '/w/yarn.lock': '' })).packageManager, 'yarn');
    assert.equal(detectProject('/w', virtualFs({ ...base, '/w/bun.lockb': '' })).packageManager, 'bun');
    assert.equal(detectProject('/w', virtualFs({ ...base, '/w/package-lock.json': '' })).packageManager, 'npm');
    assert.equal(detectProject('/w', virtualFs(base)).packageManager, 'npm');
  });

  it('degrades gracefully with no package.json at all', () => {
    const profile = detectProject('/empty', virtualFs({}));
    assert.equal(profile.primary, 'node');
    assert.ok(profile.notes.length > 0, 'expected a diagnostic note');
    assert.deepEqual(profile.dependencies, {});
  });

  it('survives a corrupt package.json', () => {
    const profile = detectProject('/w', virtualFs({ '/w/package.json': '{ "dependencies": ' }));
    assert.equal(profile.primary, 'node');
    assert.ok(profile.notes.some((n) => /package\.json/i.test(n)));
  });
});

describe('framework/strategy', () => {
  it('selects the Vite plugin for a Vite project and emits a config snippet', () => {
    const profile = detectProject(path.join(FIXTURES, 'react-vite'), fs as unknown as FsLike);
    const strategy = selectStrategy(profile, CTX);
    assert.equal(strategy.kind, 'vite-plugin');
    assert.match(strategy.snippet ?? '', /runtimeLens\(/);
    assert.match(strategy.snippet ?? '', /integrations\/vite-plugin\.js/, 'the snippet imports the shipped plugin by absolute path');
    assert.equal(strategy.env.RUNTIME_LENS_PORT, '41234');
    assert.equal(strategy.env.RUNTIME_LENS_TOKEN, 'tok');
    assert.equal(strategy.env.RUNTIME_LENS_HOST, '127.0.0.1');
    assert.equal(strategy.env.NODE_OPTIONS, undefined, 'the browser path needs no NODE_OPTIONS');
    assert.match(strategy.command ?? '', /npm run dev/);
  });

  it('selects the webpack loader for Next.js and warns about the two runtimes', () => {
    for (const fixture of ['next-pages', 'next-app']) {
      const profile = detectProject(path.join(FIXTURES, fixture), fs as unknown as FsLike);
      const strategy = selectStrategy(profile, CTX);
      assert.equal(strategy.kind, 'next-webpack-loader', fixture);
      assert.match(strategy.snippet ?? '', /webpack/);
      assert.ok(strategy.warnings.some((w) => /Server Components|Route Handlers/.test(w)), fixture);
    }
  });

  it('selects the --import hook for ESM Node and the --require hook for CJS Node', () => {
    const esm = selectStrategy(detectProject(path.join(FIXTURES, 'node-ts'), fs as unknown as FsLike), CTX);
    assert.equal(esm.kind, 'node-import-hook');
    assert.match(esm.env.NODE_OPTIONS ?? '', /--import/);
    assert.match(esm.env.NODE_OPTIONS ?? '', /node-loader\.mjs/);

    const cjs = selectStrategy(detectProject(path.join(FIXTURES, 'node-js'), fs as unknown as FsLike), CTX);
    assert.equal(cjs.kind, 'node-require-hook');
    assert.match(cjs.env.NODE_OPTIONS ?? '', /--require/);
    assert.match(cjs.env.NODE_OPTIONS ?? '', /node-require\.cjs/);
  });

  it('refuses to send a .tsx file through bare node', () => {
    const profile = detectProject(
      '/w',
      virtualFs({ '/w/package.json': JSON.stringify({ type: 'module' }), '/w/index.js': '' })
    );
    assert.equal(profile.primary, 'node');
    const strategy = selectStrategy(profile, { ...CTX, activeFile: '/w/Widget.tsx' });
    assert.ok(
      strategy.warnings.some((w) => /JSX/.test(w) && /bare node/.test(w)),
      `expected a JSX warning, got: ${strategy.warnings.join(' | ')}`
    );
  });

  it('uses the detected package manager in the suggested command', () => {
    const profile = detectProject(
      '/w',
      virtualFs({
        '/w/package.json': JSON.stringify({ dependencies: { vite: '5.0.0' }, scripts: { dev: 'vite' } }),
        '/w/vite.config.js': 'export default {}',
        '/w/pnpm-lock.yaml': ''
      })
    );
    assert.match(selectStrategy(profile, CTX).command ?? '', /pnpm dev/);
  });

  it('points the hook paths at the extension output directory', () => {
    const profile = detectProject(path.join(FIXTURES, 'node-js'), fs as unknown as FsLike);
    const strategy = selectStrategy(profile, { ...CTX, extensionOut: '/somewhere/out/src' });
    assert.match(strategy.env.NODE_OPTIONS ?? '', /\/somewhere\/out\/src\/integrations\//);
  });
});
