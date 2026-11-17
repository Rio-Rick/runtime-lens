# Runtime Lens

**See the real values your code produces, inline, while it runs.**

Runtime Lens captures `console.*` output and marked expressions from your *actually running* JS/TS
process — Node, Vite, React, Next.js (pages **and** app router), Express, Fastify, NestJS — and paints
them back onto the exact line of the original `.ts` / `.tsx` / `.jsx` / `.js` file you wrote:

```ts
const total = subtotal * (1 + taxRate);   // => 42.75 × 3
console.log('cart', cart);                // => cart {items: Array(2), owner: "ada"}
```

No breakpoints. No stepping. No `JSON.stringify` debugging. The program runs at full speed and the
editor shows what happened.

---

## How it works (30 seconds)

1. The extension starts a **localhost-only** ingest server on a free ephemeral port with a
   64-char random token.
2. It detects your project (framework, module kind, TS, JSX, routers) and picks an **integration
   strategy**: a Vite plugin, a Next.js loader (registered for both webpack and Turbopack), a
   Node `--import` hook, or a Node `--require` hook.
3. Your source is rewritten **through a Babel AST transform** — never regex — so
   `console.log(x)` becomes a probe call that forwards to the real console *and* reports a
   safely-serialized snapshot of `x`.
4. Events arrive over WebSocket (or `POST /ingest`), get remapped through source maps back to your
   original lines, land in a bounded store, and fan out to inline decorations, hovers, the
   **Runtime Lens** explorer view, diagnostics and the status bar.

Nothing leaves your machine. Under Node, Vite, and bare bundlers, nothing is written to disk in
your project at all. Under Next.js, both webpack and Turbopack require the injected agent to be
reachable through a real relative import (Turbopack rejects absolute-path specifiers outright and
only resolves modules inside the project root), so Runtime Lens mirrors two small, non-secret
runtime files into `node_modules/.cache/runtime-lens/` — the same convention `babel-loader` and
others use — and leaves everything else in your source tree untouched. See
[Safety and privacy](#safety-and-privacy) below.

---

## Quick start

1. Install the `.vsix`:

   ```bash
   code --install-extension runtime-lens-0.1.0.vsix
   ```

2. Open a JS/TS project and run **Runtime Lens: Start** (`Cmd/Ctrl+Shift+P`). The status bar shows
   `Runtime Lens: Active`.
3. Run **Runtime Lens: Show Diagnostics** — it prints the exact command or config snippet for *your*
   project, for example:

   ```bash
   # Node, CommonJS
   RUNTIME_LENS_PORT=51731 RUNTIME_LENS_TOKEN=… node --require …/out/src/integrations/node-require.cjs index.js

   # Node, ESM or TypeScript
   RUNTIME_LENS_PORT=51731 RUNTIME_LENS_TOKEN=… node --import …/out/src/integrations/node-loader.mjs src/index.ts
   ```

   ```ts
   // vite.config.ts — Vite / React
   import { defineConfig } from 'vite';
   import runtimeLens from '…/out/src/integrations/vite-plugin.js';

   export default defineConfig({ plugins: [runtimeLens()] });
   ```

   ```js
   // next.config.js — Next.js (pages and/or app router), webpack + Turbopack
   const nextConfig = {
     // Turbopack (Next.js 16+ default, or `next dev/build --turbopack` on 13-15).
     // Use `experimental: { turbo: { rules: {...} } }` instead of the top-level
     // `turbopack` key on Next.js < 15.3.
     turbopack: {
       rules: {
         '*.ts': [
           { condition: { all: ['browser', { not: 'foreign' }] }, loaders: [{ loader: '…/out/src/integrations/webpack-loader.js', options: { target: 'browser' } }], as: '*.ts' },
           { condition: { all: [{ not: 'browser' }, { not: 'foreign' }] }, loaders: [{ loader: '…/out/src/integrations/webpack-loader.js', options: { target: 'node' } }], as: '*.ts' }
         ]
         // …repeat for '*.tsx', '*.js', '*.jsx'
       }
     },
     // webpack (the default before Next.js 16, or with `--webpack`).
     webpack(config) {
       config.module.rules.push({
         test: /\.(js|jsx|ts|tsx)$/,
         exclude: /node_modules|\.next/,
         use: [{ loader: '…/out/src/integrations/webpack-loader.js' }],
         enforce: 'pre'
       });
       return config;
     }
   };
   module.exports = nextConfig;
   ```

   Run **Runtime Lens: Show Diagnostics** to get this whole block generated for you, with the
   right key (`turbopack` vs `experimental.turbo`) picked automatically from your installed
   `next` version, and all four extensions filled in. Both blocks are always emitted together so
   the config keeps working no matter which bundler your `dev`/`build` script actually invokes.

4. Run your app the way you normally do. Values start appearing.

Environment variables the hooks read: `RUNTIME_LENS_PORT`, `RUNTIME_LENS_TOKEN`,
`RUNTIME_LENS_HOST` (default `127.0.0.1`), `RUNTIME_LENS_LABEL`. **If the port/token are absent the
hooks are completely inert** — your program runs exactly as it did before, so it is safe to leave the
plugin in a config file.

---

## What gets captured

| Source | Shown as |
| --- | --- |
| `console.log / info / warn / error / debug / table` | inline value at end of line + explorer row |
| multiple arguments | all of them, space-separated, each independently serialized |
| an expression with a trailing `// ?` | `// => <value>` on that line |
| repeated execution of the same probe | `// => <value> × N` (execution count) |
| a repeated probe whose value changed | `// => 120 × 37 (was 118)` |
| a probe that prints a number, 3+ runs | `// => 120 × 37 · min 3 · max 120 ▁▂▃▅▇` (range over the whole run, trend of the last 8 values) |
| hovering an inline value | the last runs (shortened) plus an **Open all N runs** link: opens the Explorer scoped to that one value, where selecting a run shows its full value |
| uncaught errors / unhandled rejections | error row + optional diagnostic |

Values are serialized by a purpose-built safe serializer that handles strings (length-capped),
numbers (including `NaN` / `±Infinity`), booleans, `null`, `undefined`, arrays, nested objects,
`Date`, `RegExp`, `Map`, `Set`, `BigInt`, `Error` (with stack and own props), typed arrays,
functions (name/kind/arity), **circular references** (rendered as `[Circular → path]`) and
depth-limited subtrees. It never throws, never invokes getters twice, and never walks more than a
fixed node budget, so a huge object graph cannot stall your app.

---

## Commands

| Command | ID |
| --- | --- |
| Start | `runtimeLens.start` |
| Stop | `runtimeLens.stop` |
| Restart | `runtimeLens.restart` |
| Clear Logs | `runtimeLens.clearLogs` |
| Pause Capture | `runtimeLens.pauseCapture` |
| Resume Capture | `runtimeLens.resumeCapture` |
| Show Runtime Explorer | `runtimeLens.showRuntimeExplorer` |
| Toggle Inline Values | `runtimeLens.toggleInlineValues` |
| Show Diagnostics | `runtimeLens.showDiagnostics` |
| Search / Filter Events | `runtimeLens.setFilter` |
| Toggle Follow Latest | `runtimeLens.toggleFollow` |
| Reveal Event Source | `runtimeLens.revealEvent` |
| Copy Event Value | `runtimeLens.copyEventValue` |
| Copy Event as JSON | `runtimeLens.copyEventJson` |
| Disconnect Session | `runtimeLens.disconnectSession` |
| Export Log | `runtimeLens.exportLog` |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `runtimeLens.enabled` | `true` | Master switch; when off nothing starts and nothing is instrumented. |
| `runtimeLens.inlineValues` | `true` | Render values as end-of-line decorations. |
| `runtimeLens.captureConsole` | `true` | Capture `console.*`. |
| `runtimeLens.captureExpressions` | `true` | Capture `// ?` expression probes. |
| `runtimeLens.maxInlineLength` | `120` | Character cap for an inline decoration. |
| `runtimeLens.objectDepth` | `3` | Serialization depth for objects/arrays/Map/Set. |
| `runtimeLens.maxEntries` | `100` | Entries captured per array/object/Map/Set (1–1000). Larger ones show "… N more not captured". |
| `runtimeLens.maxNodes` | `5000` | Total values captured from one logged value or probe (100–100000). Raise together with `maxEntries`. |
| `runtimeLens.maxHistory` | `5000` | Bounded event history size. |
| `runtimeLens.showTimestamp` | `false` | Show capture time inline and in the explorer. |
| `runtimeLens.showExecutionCount` | `true` | Show `× N` execution counts. |
| `runtimeLens.showPreviousValue` | `true` | Append `(was X)` inline when a repeated probe's value changed. |
| `runtimeLens.showValueStats` | `true` | Show `min / max` and a sparkline inline for numeric probes. Tracked incrementally, so it covers the whole run, not just the retained history. |
| `runtimeLens.hoverHistory` | `10` | Previous runs listed when hovering an inline value (consecutive duplicates collapse to `×N`). `0` disables. |
| `runtimeLens.port` | `0` | Preferred port; `0` = pick a free one. |
| `runtimeLens.maxPayloadBytes` | `262144` | Hard cap on a single ingest batch. |

---

## The Runtime Lens view

The activity-bar view is a tree of live events (newest first) with:

- **search / filter** by text, level, kind and file,
- **pause / resume** (the process keeps running; the editor just stops updating),
- **follow latest** toggle,
- **clear**,
- **click-to-source** — jumps to the exact original line,
- a **webview inspector** (`Show Runtime Explorer`) for expanding deep object trees, plus a hover
  tree inspector on any instrumented line,
- **copy event as JSON** (`runtimeLens.copyEventJson`) — copies the complete normalized event plus its
  session and source metadata, which is useful for bug reports and protocol debugging,
- **export log** (`runtimeLens.exportLog`) — saves the events currently visible (respecting any
  active search/level/file filter) to a JSON file you pick, oldest-first, one event per entry with
  its value, location, level, execution count and timestamp. Handy for attaching a capture session
  to a bug report, or diffing what a change did between two runs. Nothing is sent anywhere; it's a
  local file write through the same save dialog any other "Save As" uses,
- **disconnect session** (`runtimeLens.disconnectSession`, inline button on a session node) — closes
  a session's live connection and clears it from the list. Mainly for cleaning up a zombie session
  left behind by a process that crashed or was killed without sending its final "goodbye" — a
  process that's still actually running just reconnects on its own the next time it captures
  something, the same as after any other dropped connection.

---

## Safety and privacy

- The server binds `127.0.0.1` only, on an ephemeral port, and requires a per-session 64-char token
  on both the WebSocket handshake (`/rl?token=…`) and the HTTP `/ingest` header.
- Every message is validated against a versioned protocol (`bad-version`, `bad-token`,
  `bad-message`, `too-large` are answered and the session closed).
- Payloads are size-capped (default 256 KiB per batch, hard ceiling 4 MiB) and batches are capped at
  500 events.
- Buffers are bounded on both sides; under load the agent drops events and reports the drop count
  rather than growing memory or blocking your program.
- `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`, `.git`, `*.d.ts` and `*.min.js` are
  never instrumented.
- Under the Next.js webpack/Turbopack loader only, Runtime Lens writes two small runtime files
  (the port/token-configured browser agent and a static, self-contained Node agent bundle - no
  user source, no captured values) to `node_modules/.cache/runtime-lens/` in your project so the
  bundler can reach them via a relative import; they're regenerated on demand and safe to add to
  `.gitignore` alongside the rest of `node_modules`.
- Runtime Lens never runs a `.tsx`/`.jsx` file through bare `node`; it refuses with an actionable
  message pointing at the bundler-based strategy instead.

---

## Development

```bash
npm install
npm run compile        # tsc -p ./ && node scripts/copy-assets.js
npm test               # mocha, 178 tests (unit + real end-to-end node runs)
npx @vscode/vsce package
```

Press `F5` in VS Code to launch the Extension Development Host (`.vscode/launch.json` is included).

Requires Node 18+ and VS Code 1.85+.

## Known limitations

See `KNOWN_LIMITATIONS` in the project report: JSX-in-node refusal, webpack loader ordering with
custom Next configs, no browser-devtools-style live object expansion (snapshots only), and no
`console.group` indentation modelling yet.

Turbopack-specific: Turbopack implements only a core subset of the webpack loader API (via
`loader-runner`), so a handful of things behave differently there than under webpack:
- No `this.target`, `this.mode`, `this.version`, `this.fs` (beyond `readFile`), `emitFile`,
  `importModule`/`loadModule`, `this.resolve`, or `this.utils`. Runtime Lens only relies on
  `resourcePath`, `cacheable`, `getOptions`, `emitWarning` and `callback`, all of which are
  supported — the client/server split that used to come from `this.target` is now passed in
  explicitly as a loader option instead (see `turbopack.rules` in the generated config).
- Rules are matched per file extension with an explicit `not: 'foreign'` condition standing in
  for webpack's `exclude: /node_modules/`; if Next.js changes what counts as "foreign" this could
  drift from the webpack `exclude` pattern.
- Turbopack treats any import specifier starting with `/` as a "server relative" import (a
  public-URL-style path, not a filesystem path) and doesn't resolve it — there's no upstream fix
  planned (https://github.com/vercel/next.js/issues/72575). It also only resolves modules inside
  the detected project root. Since the extension's own install directory (and the OS temp dir the
  browser agent used to live in) are both outside that root and outside any relative path from a
  source file, a plain `path.join(__dirname, ...)` specifier fails under Turbopack even when
  rewritten as relative. Runtime Lens works around this by mirroring the two runtime agent files
  into `node_modules/.cache/runtime-lens/` inside the project (see
  [Safety and privacy](#safety-and-privacy)) and importing that copy through a real relative
  specifier computed from the file being compiled — which resolves identically under plain
  webpack, so there's no behavioral split there.
- If you're on Next.js < 13 there's no Turbopack to speak of, so only the `webpack()` block is
  emitted.

## License

MIT — see `LICENSE`.
