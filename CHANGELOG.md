# Changelog

All notable changes to Runtime Lens are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`Disconnect Session` command (`runtimeLens.disconnectSession`).** Closes a session's live
  connection (if it still has one) and clears it from the Runtime Lens view — for cleaning up a
  zombie session left behind by a process that crashed or was force-killed without sending its
  final `bye`. A process that's still genuinely alive just reconnects on its own the next time it
  captures something, so this is a "clear this from my view" action, not a way to silence a session
  for good. Available as an inline button on a session's node in the tree.

- **`Copy Event as JSON` command (`runtimeLens.copyEventJson`).** Copies the complete normalized
  event — protocol version, source location, session id, and the raw event payload — as formatted
  JSON, for bug reports or protocol-level debugging. Complements `Copy Event Value`, which copies
  only the rendered value.

- **The agent now automatically reconnects** if its connection to the editor drops while there's
  still unsent data queued, instead of giving up for the rest of the process's life. On reconnect
  it re-sends `hello` before anything else, since the server requires a fresh handshake per
  connection. The server, in turn, replaces a still-registered session atomically when a new
  `hello` arrives for the same session id, so a reconnect can't race the old connection's `close`
  event into evicting the session that just replaced it.

- **`Export Log` command (`runtimeLens.exportLog`).** Saves the events currently visible in the
  Runtime Lens view — respecting any active search/level/file filter — to a JSON file, oldest-first,
  with each event's rendered value, source location, level, execution count and timestamp. Useful
  for attaching a capture session to a bug report or comparing two runs. Available from the command
  palette and the explorer view's toolbar.

### Fixed

- **Inline decorations and the `× N` execution count could silently show a stale value from long
  before the ring buffer's actual history, and the store's per-line/per-probe indexes grew without
  bound for the life of the extension.** `EventStore.add()` set `byLine`/`countsByProbe` for every
  new event but never removed the previous entry when the ring buffer evicted it to stay within
  `maxHistory` — so `byLine`/`countsByProbe` kept every file:line and probe id ever seen, for as
  long as the extension window stayed open, regardless of how old the underlying event actually
  was. Two consequences: unbounded memory growth over a long session (many edits, many restarts of
  the debugged program), and `latestAt()`/`forFile()` (what inline decorations render) could return
  an event that had already fallen out of the bounded history, showing what looked like a current
  value that was actually long gone. `RingBuffer.push()` now returns the item it evicted (if any),
  and the store retires that same item from its indexes — falling back to the next-most-recent
  survivor for that line/probe, or removing the entry entirely once nothing for it remains — so
  both indexes stay exactly in sync with what the ring buffer actually holds, bounded by the same
  `maxHistory` limit.

- **A captured value from a hostile object (e.g. a `Proxy` that throws from `Symbol.toStringTag`)
  could crash the instrumented program instead of just failing to render.** `serialize()`'s
  type-tag lookup and its top-level entry point are now wrapped in their own `try`/`catch`,
  falling back to a safe `unserializable` marker — consistent with the rest of the serializer,
  which already tolerated throwing getters and indices, just not a throw from *identifying* the
  value's type in the first place.

- **`console.log` (and the other console methods) resolved to a constructor-time function
  reference, so a program that monkey-patches `console` after Runtime Lens attaches had its patch
  silently bypassed** — instrumented output went to the *original* method, not whatever the
  program had since replaced it with, changing what the program visibly did. `Agent.c()` now
  resolves `console[level]` fresh on every call and invokes it with the console object as `this`
  (via `Reflect.apply`), so a later monkey-patch is honoured exactly as it would be without
  instrumentation — including throwing if the program replaces a console method with something
  non-callable, which is what an uninstrumented call would do too.

- **A malformed or oversized field deep inside a batch (an absurd string length, a fractional
  "count", thousands of array entries in one value, `Infinity` slipping through a loosely-typed
  numeric check) could pass validation and reach the editor.** Client-message validation now
  bounds every numeric field to a safe, finite range and every array/object/Map/Set to a sane
  maximum entry count, matching the serializer's own (much lower) limits with generous headroom —
  the agent could never legitimately produce a message that trips these checks, but a corrupted or
  unexpected payload no longer gets a free pass into the rest of the extension.

- **A path containing spaces, `#`, `%`, or other characters needing URL-encoding (common on
  Windows, e.g. `C:\Users\Jane Doe\...`) could resolve to the wrong module or fail outright** under
  the Node ESM loader hook, which built a `file://` URL by hand-replacing backslashes instead of
  using Node's own `pathToFileURL()`. It now uses the latter, which handles every platform's
  quirks correctly.

- **A batch of already-captured events could be silently and permanently dropped once several sessions' normal output added up.** `Agent.flush()` split outgoing batches purely by event count (`maxBatchEvents`), with no awareness of the server's `maxPayloadBytes` ceiling. A batch that happened to land over that limit was rejected by the server in full, and the agent had no way to notice or recover — those events were just gone, with nothing but a log line in the output channel to show for it. `flush()` now also bounds each batch by an approximate byte size (`maxBatchBytes`), and the server tells every connected agent its real configured `maxPayloadBytes` on connect so batches are sized against the actual limit rather than a guess. A single event that's oversized on its own still ships alone rather than blocking everything behind it. The status bar also now surfaces a `too-large` rejection as an error (self-clearing once the next batch succeeds) instead of only logging it, so if one still slips through you'll actually see it.

- **A one-shot Node script instrumented by Runtime Lens could hang forever instead of exiting.**
  On Node 22+ the agent prefers the global `WebSocket` transport (see the `Clear Logs` entry
  below), and that connection's underlying socket was never closed or unref'd. The socket alone
  was enough to keep the event loop — and the host process — alive indefinitely after the
  program's own work was done, so a plain `node --require .../index.js` run would sit there until
  killed by hand. The socket is now unref'd once it's finished opening and has drained whatever
  was queued during the handshake, so the process can exit on its own the moment it's genuinely
  idle, without dropping events buffered while still connecting. The HTTP fallback transport
  (used when no global `WebSocket` is available) had the same latent issue with its keep-alive
  socket and got the equivalent fix.

- **`Clear Logs` now resets execution counts on the agent, not just the editor's view.** Every
  captured `console.log`/expression probe carries a `× N` execution count computed inside the
  *instrumented* process, not the editor. `Clear Logs` only ever emptied the editor's own history,
  so a probe that had already run a few times would keep counting up from its pre-clear value on
  the next hit instead of restarting at `× 1` — Clear looked like it reset things, but new data
  kept summing with what came before. The protocol gained a small `reset` push
  (`ServerResetMessage`) that the extension now sends to every connected agent when you clear, and
  the agent zeroes its per-probe counters on receipt (`Agent.resetCounts()`); `seq`, used only for
  wire ordering, is left untouched. This reaches any agent connected over WebSocket, which is the
  default transport whenever a global `WebSocket` is available (all browsers, Node 22+). Agents
  that fell back to the HTTP batch transport (no global `WebSocket`, e.g. Node < 18–21) have no
  channel for the editor to push anything down — the same pre-existing limitation live `config`
  pushes (capture toggles, object depth) already had — so `Clear Logs` now also warns by name when
  it can't reach a connected session for this reason, rather than clearing silently.
- **Turbopack support for Next.js.** The generated `next.config.*` snippet now wires the
  instrumenting loader into `turbopack.rules` (or `experimental.turbo.rules` on Next.js
  13.0–15.2) alongside the existing `webpack()` registration, so Runtime Lens works whether a
  project runs `next dev` under webpack, `--turbopack`/`--turbo`, or the Turbopack-by-default
  Next.js 16+. Because Turbopack's loader context doesn't implement `this.target`, the
  client/server split is now passed explicitly through a `target` loader option (driven by
  Turbopack's built-in `browser` / `not: 'browser'` rule conditions) instead of being read off
  the loader context; the webpack path is unaffected and still uses `this.target`.
- `ProjectProfile` now records the detected `next` major/minor version, used to pick between the
  `turbopack` and `experimental.turbo` config keys (and to skip Turbopack config entirely below
  Next.js 13, where it doesn't exist).

### Fixed

- **`Module not found` / "server relative imports are not implemented yet" under Turbopack.** The
  Next.js loader used to import the runtime agent by its absolute filesystem path (the extension's
  own install directory, or an OS-temp-dir file for the browser agent). Webpack resolves that
  fine; Turbopack treats any specifier starting with `/` as a server-relative (public URL) import
  and refuses to resolve it at all (no upstream fix planned:
  https://github.com/vercel/next.js/issues/72575), and separately only resolves modules that live
  inside the detected project root — which the extension's install directory and the OS temp dir
  never are. The loader now mirrors the (non-secret) browser/node agent files into
  `node_modules/.cache/runtime-lens/` inside the project and imports that copy through a real
  relative specifier computed from the file being compiled. This resolves identically under plain
  webpack, so nothing changes there.
- **`Module not found: Can't resolve './core'` after the fix above.** Mirroring only
  `node-agent.js` wasn't enough on its own: it `require()`s sibling files (`./core`,
  `./node-transport`, which in turn pulls in `./ws-transport` and `../protocol` /
  `../serialization/serializer`) that never got copied alongside it into
  `node_modules/.cache/runtime-lens/`. `node-agent.ts` is now bundled with esbuild into a single,
  dependency-free CommonJS file at build time (the same treatment `browser-agent.ts` already got
  for the browser bundle), so the one file that gets mirrored is fully self-contained - there's no
  sibling-file list to keep in sync as the agent's own internals change.

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
