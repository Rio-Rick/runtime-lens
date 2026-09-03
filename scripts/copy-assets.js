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

// 3. Activity-bar icon (also referenced from package.json).
copy(path.join(root, 'media', 'lens.svg'), path.join(root, 'out', 'media', 'lens.svg'));

// 4. Bundle the browser agent to a single ESM file.
const esbuild = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
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
