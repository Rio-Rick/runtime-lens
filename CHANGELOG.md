# Changelog

All notable changes to Runtime Lens are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-02

First working release. Everything below is implemented and covered by the test suite
(178 tests, including end-to-end runs of real `node` processes).

### Added

**Runtime capture**
- Localhost-only ingest server: ephemeral free-port selection, per-session 64-character token,
  WebSocket endpoint `/rl?token=…`, HTTP `POST /ingest` fallback and `GET /health`.
- Versioned wire protocol with strict validation (`bad-version`, `bad-token`, `bad-message`,
  `too-large`, `internal`), a 500-event batch cap, a configurable per-batch byte cap
  (default 256 KiB) and a hard 4 MiB ceiling.
- Agent with bounded ring buffer, timer + size based batching, drop accounting, and a strict
  "never throw, never block the host program" contract.

**Instrumentation**
- Babel AST transform (no regex anywhere) for `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs` that
  preserves comments and original locations and emits chained source maps.
- Content-addressed probe ids (sha1-12 of file + kind + normalized text + line) that stay stable
  across restarts and bundlers, which is what makes execution counts meaningful.
- Idempotency marker plus a cheap textual pre-filter so files with nothing to capture are skipped
  without a parse.
- `console.log / info / warn / error / debug / table` capture with multiple arguments, and
  expression probes marked with a trailing `// ?`.
- Source-map remapping back to original `.ts` / `.tsx` / `.jsx` / `.js` lines, including inline maps
  and repeated-map protection.

**Framework integration**
- Detection of Next.js (pages, app and hybrid routers), React, Vite, webpack, Express, Fastify,
  NestJS and plain Node, from `package.json`, `next.config.*`, `vite.config.*`, `webpack.config.*`,
  `tsconfig.json` and `jsconfig.json`; module kind, TypeScript, JSX, entry point and package manager
  are inferred too.
- Per-framework strategies: Vite plugin (`enforce: 'pre'`, `apply: 'serve'`, virtual agent module),
  Next.js webpack loader for both compiler passes, Node `--import` hook (ESM + TypeScript) and Node
  `--require` hook (CommonJS).
- Hard refusal to execute `.tsx` / `.jsx` through bare `node`, with an actionable message.
- All integrations are inert without a port and token, so they can be left in a config file safely.

**Editor experience**
- Throttled inline value decorations rendered as `// => value × N`, with a configurable length cap.
- Hover provider with a tree inspector for the captured value.
- "Runtime Lens" activity-bar tree view: search/filter (text, level, kind, file), pause, resume,
  follow-latest, clear, click-to-source, copy value.
- Webview runtime explorer for expanding deep structures.
- Status bar states: Active, Paused, Disconnected, Error.
- Diagnostics report with the exact command or config snippet for the detected project.
- 13 commands and 11 settings, all functional.

**Serialization**
- Safe serializer covering strings (length-capped), numbers (`NaN`, `±Infinity`), booleans, `null`,
  `undefined`, arrays, nested objects, `Date`, `RegExp`, `Map`, `Set`, `BigInt`, `Error` (message,
  stack, own props), typed arrays, functions, circular references, depth limits and a global node
  budget; unserializable values degrade to a hint instead of throwing.

**Project hygiene**
- `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`, `.git`, `*.d.ts` and `*.min.js` are
  never instrumented.
- Five runnable fixtures: `node-js`, `node-ts`, `react-vite`, `next-pages`, `next-app`.
- Test suite: parsing (JS/TS/JSX/TSX), AST transform, source maps, console interception, serializer,
  circular structures, protocol validation, WebSocket + HTTP transport, project detection, strategy
  selection, event store/indexes, utilities, and end-to-end capture from real `node` processes.

[0.1.0]: https://github.com/runtime-lens/runtime-lens/releases/tag/v0.1.0
