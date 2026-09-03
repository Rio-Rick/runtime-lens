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
   strategy**: a Vite plugin, a Next.js webpack loader, a Node `--import` hook, or a Node
   `--require` hook.
3. Your source is rewritten **through a Babel AST transform** — never regex — so
   `console.log(x)` becomes a probe call that forwards to the real console *and* reports a
   safely-serialized snapshot of `x`.
4. Events arrive over WebSocket (or `POST /ingest`), get remapped through source maps back to your
   original lines, land in a bounded store, and fan out to inline decorations, hovers, the
   **Runtime Lens** explorer view, diagnostics and the status bar.

Nothing is written to disk in your project. Nothing leaves your machine.

---

## Quick start

Installation
1. Build the .vsix package

Clone the repository and install the project dependencies:

npm install

Install vsce as a development dependency:

npm install --save-dev @vscode/vsce

Package the extension:

npx vsce package

This will create a .vsix file in the project directory:

runtime-lens-0.1.0.vsix
2. Install the .vsix in VS Code

Install the generated VSIX:

code --install-extension runtime-lens-0.1.0.vsix

Or, in VS Code:

Open the Extensions panel.
Click the ... menu.
Select Install from VSIX....
Select runtime-lens-0.1.0.vsix.
3. Start Runtime Lens

Open a JavaScript/TypeScript project and run:

Runtime Lens: Start

Open the Command Palette with Cmd/Ctrl+Shift+P and search for:

Runtime Lens: Start

The status bar should show:

Runtime Lens: Active
4. Configure Runtime Lens

Run:

Runtime Lens: Show Diagnostics

This prints the exact command or configuration snippet required for your project.

For example, for Node.js CommonJS:

RUNTIME_LENS_PORT=51731 RUNTIME_LENS_TOKEN=… node --require …/out/src/integrations/node-require.cjs index.js

For Node.js ESM or TypeScript:

RUNTIME_LENS_PORT=51731 RUNTIME_LENS_TOKEN=… node --import …/out/src/integrations/node-loader.mjs src/index.ts

For Vite / React:

// vite.config.ts
import { defineConfig } from 'vite';
import runtimeLens from '…/out/src/integrations/vite-plugin.js';

export default defineConfig({
  plugins: [runtimeLens()]
});

For Next.js:

// next.config.js
const nextConfig = {
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
5. Run your application

Run your application normally.

Runtime Lens will begin displaying runtime values from your application.

Environment Variables

Runtime Lens uses the following environment variables:

Variable	Description	Default
RUNTIME_LENS_PORT	Runtime Lens server port	—
RUNTIME_LENS_TOKEN	Authentication token	—
RUNTIME_LENS_HOST	Runtime Lens server host	127.0.0.1
RUNTIME_LENS_LABEL	Optional runtime label	—

If RUNTIME_LENS_PORT or RUNTIME_LENS_TOKEN is not present, the hooks are completely inert. Your application will run normally without Runtime Lens instrumentation.

---

## What gets captured

| Source | Shown as |
| --- | --- |
| `console.log / info / warn / error / debug / table` | inline value at end of line + explorer row |
| multiple arguments | all of them, space-separated, each independently serialized |
| an expression with a trailing `// ?` | `// => <value>` on that line |
| repeated execution of the same probe | `// => <value> × N` (execution count) |
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

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `runtimeLens.enabled` | `true` | Master switch; when off nothing starts and nothing is instrumented. |
| `runtimeLens.inlineValues` | `true` | Render values as end-of-line decorations. |
| `runtimeLens.captureConsole` | `true` | Capture `console.*`. |
| `runtimeLens.captureExpressions` | `true` | Capture `// ?` expression probes. |
| `runtimeLens.maxInlineLength` | `120` | Character cap for an inline decoration. |
| `runtimeLens.objectDepth` | `3` | Serialization depth for objects/arrays/Map/Set. |
| `runtimeLens.maxHistory` | `5000` | Bounded event history size. |
| `runtimeLens.showTimestamp` | `false` | Show capture time inline and in the explorer. |
| `runtimeLens.showExecutionCount` | `true` | Show `× N` execution counts. |
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
  tree inspector on any instrumented line.

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

## License

MIT — see `LICENSE`.
