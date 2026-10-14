/**
 * Post-compile asset step.
 *
 * 1. Copies the hand-written JS/ESM assets that must ship verbatim (Node hooks,
 *    webview media) into `out/`.
 * 2. Bundles the browser agent into a single dependency-free ESM file with
 *    esbuild, because it is injected into the *user's* browser bundle and must
 *    not carry CommonJS interop or relative imports.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'out', 'src');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`copied ${path.relative(root, from)} -> ${path.relative(root, to)}`);
}

function copyDir(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(src, dst);
    } else {
      copy(src, dst);
    }
  }
}

// 1. Node hook assets (shipped as-is; they are plain JS by design).
for (const name of ['node-loader.mjs', 'node-hooks.mjs', 'node-require.cjs']) {
  copy(path.join(root, 'src', 'integrations', name), path.join(out, 'integrations', name));
}

// 2. Webview media.
copyDir(path.join(root, 'src', 'webview', 'media'), path.join(out, 'webview', 'media'));

const esbuild = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
// 2b. Bundle the React Webview separately from the extension host.
// React/ReactDOM are bundled into this browser artifact, so the installed
// extension does not depend on a CDN or a UI framework runtime at page load
// (which is why they are devDependencies). NODE_ENV must be defined: without
// it React ships its ~1 MB development build. Styling is the plain
// `media/style.css` copied above and linked by panel.ts, so the entry point
// imports no CSS (importing it would emit a second, unused main.css).
const webviewEntry = path.join(root, 'src', 'webview', 'main.tsx');
const webviewTarget = path.join(out, 'webview', 'media', 'main.js');
fs.mkdirSync(path.dirname(webviewTarget), { recursive: true });
execFileSync(
  esbuild,
  [
    webviewEntry,
    '--bundle',
    '--format=iife',
    '--platform=browser',
    '--target=es2020',
    '--legal-comments=none',
    '--minify',
    '--define:process.env.NODE_ENV="production"',
    `--outfile=${webviewTarget}`
  ],
  { stdio: 'inherit', cwd: root }
);
console.log(`bundled ${path.relative(root, webviewEntry)} -> ${path.relative(root, webviewTarget)}`);

// 3. Activity-bar icon (also referenced from package.json).
copy(path.join(root, 'media', 'lens.svg'), path.join(root, 'out', 'media', 'lens.svg'));

// 4. Bundle the browser agent to a single ESM file.
const entry = path.join(root, 'src', 'agent', 'browser-agent.ts');
const target = path.join(out, 'agent', 'browser-agent.mjs');
fs.mkdirSync(path.dirname(target), { recursive: true });
execFileSync(
  esbuild,
  [
    entry,
    '--bundle',
    '--format=esm',
    '--platform=browser',
    '--target=es2020',
    '--external:node:http',
    '--legal-comments=none',
    `--outfile=${target}`
  ],
  { stdio: 'inherit', cwd: root }
);
console.log(`bundled ${path.relative(root, entry)} -> ${path.relative(root, target)}`);

// 5. Bundle the node agent to a single, dependency-free CJS file.
//
// The Next.js loader mirrors this exact file into the *user's* project
// (`node_modules/.cache/runtime-lens/`, see webpack-loader.ts) so it can be
// reached through a relative import Turbopack will actually resolve. If it
// were left as tsc's plain multi-file output, that copy would `require('./core')`
// / `require('./node-transport')` and 404 on siblings that never got copied
// alongside it. Bundling collapses the whole agent/core/protocol/serialization
// graph into one file, so there is nothing left to go missing - and it stays
// correct automatically as that graph changes, with no file list to maintain.
const nodeEntry = path.join(root, 'src', 'agent', 'node-agent.ts');
const nodeTarget = path.join(out, 'agent', 'node-agent.js');
execFileSync(
  esbuild,
  [
    nodeEntry,
    '--bundle',
    '--format=cjs',
    '--platform=node',
    '--target=node18',
    '--external:node:http',
    '--sourcemap',
    '--legal-comments=none',
    `--outfile=${nodeTarget}`
  ],
  { stdio: 'inherit', cwd: root }
);
console.log(`bundled ${path.relative(root, nodeEntry)} -> ${path.relative(root, nodeTarget)}`);
