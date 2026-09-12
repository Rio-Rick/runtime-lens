import * as fs from 'node:fs';
import * as path from 'node:path';
import { instrument } from '../instrumentation/transform';
import { requiresJsxCapableRuntime, shouldInstrument, toModuleSpecifier } from '../utils/paths';

interface MinimalLoaderContext {
  resourcePath: string;
  target?: string;
  cacheable?: (flag: boolean) => void;
  callback: (err: Error | null, code?: string, map?: unknown) => void;
  emitWarning?: (warning: Error) => void;
  getOptions?: () => Record<string, unknown>;
}

/**
 * Turbopack treats any import specifier starting with `/` as a "server
 * relative import" (as if it were a public-root URL) rather than an absolute
 * filesystem path, and does not resolve it - there's no fix planned
 * (https://github.com/vercel/next.js/issues/72575, tracked upstream since
 * vercel/turborepo#3573). Turbopack also only resolves modules that live
 * inside the detected project root
 * (https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory),
 * which rules out both the extension's own install directory and the OS temp
 * dir the agent files used to live in.
 *
 * So instead of importing those files directly by absolute path, the loader
 * mirrors them into the project's own `node_modules/.cache/runtime-lens/`
 * (the same convention as `node_modules/.cache/babel-loader`) and imports
 * that copy through a real relative specifier computed from the file being
 * compiled. This resolves identically under plain webpack.
 */
const projectRootCache = new Map<string, string>();

const ROOT_MARKERS = ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb'];

function findProjectRoot(fromFile: string): string {
  const startDir = path.dirname(fromFile);
  const cached = projectRootCache.get(startDir);
  if (cached) {
    return cached;
  }
  let dir = startDir;
  for (;;) {
    if (ROOT_MARKERS.some((marker) => fs.existsSync(path.join(dir, marker)))) {
      projectRootCache.set(startDir, dir);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // No marker found anywhere above the file; fall back to its own directory
      // rather than failing outright.
      projectRootCache.set(startDir, startDir);
      return startDir;
    }
    dir = parent;
  }
}

function writeIfChanged(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing !== contents) {
    fs.writeFileSync(target, contents, 'utf8');
  }
}

/**
 * Materialise a configured browser agent inside the project's cache dir.
 *
 * A webpack/Turbopack client bundle has no access to `process.env`, so the
 * port/token have to be baked into a module rather than read at runtime. The
 * generated module intentionally uses a stable filename so bundlers such as
 * Turbopack do not have to resolve a brand-new dependency path after every
 * Runtime Lens restart.
 */
function ensureConfiguredBrowserAgent(cacheDir: string, port: number, token: string, host: string, depth: number): string {
  const target = path.join(cacheDir, 'browser-agent.mjs');
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent', 'browser-agent.mjs'), 'utf8');
  const header = `globalThis.__RUNTIME_LENS_CONFIG__ = ${JSON.stringify({
    port,
    token,
    host,
    runtime: 'browser',
    objectDepth: depth
  })};\n`;
  writeIfChanged(target, header + source);
  return target;
}

/** Mirror the static node agent into the project cache dir so a relative import can reach it. */
function ensureNodeAgent(cacheDir: string): string {
  const target = path.join(cacheDir, 'node-agent.js');
  writeIfChanged(target, fs.readFileSync(path.join(__dirname, '..', 'agent', 'node-agent.js'), 'utf8'));
  return target;
}

/**
 * Webpack loader used for Next.js (client and server compiler passes, under
 * both webpack and Turbopack).
 * Registered with `enforce: 'pre'` so it sees the original TS/JSX source
 * before SWC rewrites it.
 */
function runtimeLensLoader(this: MinimalLoaderContext, source: string, inputMap?: unknown): void {
  this.cacheable?.(false);
  const file = this.resourcePath;
  const options = this.getOptions?.() ?? {};

  const port = Number.parseInt(String(options.port ?? process.env.RUNTIME_LENS_PORT ?? ''), 10);
  const token = String(options.token ?? process.env.RUNTIME_LENS_TOKEN ?? '');
  const host = String(options.host ?? process.env.RUNTIME_LENS_HOST ?? '127.0.0.1');
  const depth = Number.parseInt(String(options.objectDepth ?? process.env.RUNTIME_LENS_DEPTH ?? '3'), 10) || 3;

  if (!Number.isInteger(port) || port <= 0 || token.length === 0 || !shouldInstrument(file)) {
    this.callback(null, source, inputMap);
    return;
  }

  // Turbopack's loader context doesn't implement `this.target`
  // (https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#missing-webpack-loader-features),
  // so the Turbopack rules pass the compiler pass explicitly via a loader
  // option ('browser' | 'node') instead. Plain webpack never sets this
  // option, so it falls through to the `this.target` webpack has always set.
  const declaredTarget = typeof options.target === 'string' && options.target.length > 0 ? options.target : undefined;
  const effectiveTarget = declaredTarget ?? this.target;
  const isBrowserTarget =
    effectiveTarget === undefined ||
    effectiveTarget === 'web' ||
    effectiveTarget === 'webworker' ||
    effectiveTarget === 'browser';

  let agentModule: string;
  try {
    const cacheDir = path.join(findProjectRoot(file), 'node_modules', '.cache', 'runtime-lens');
    const agentFile = isBrowserTarget
      ? ensureConfiguredBrowserAgent(cacheDir, port, token, host, depth)
      : ensureNodeAgent(cacheDir);
    agentModule = toModuleSpecifier(file, agentFile);
  } catch (err) {
    this.emitWarning?.(new Error(`runtime-lens: could not prepare agent module (${(err as Error).message})`));
    this.callback(null, source, inputMap);
    return;
  }

  try {
    const result = instrument(source, {
      filename: file,
      agentModule,
      moduleKind: 'esm',
      sourceMaps: true,
      captureConsole: options.captureConsole !== false,
      captureExpressions: options.captureExpressions !== false
    });
    if (result.skipped) {
      this.callback(null, source, inputMap);
      return;
    }
    this.callback(null, result.code, result.map ?? inputMap);
  } catch (err) {
    // Never break a build because of instrumentation.
    this.emitWarning?.(
      new Error(
        `runtime-lens: skipped ${path.basename(file)}${
          requiresJsxCapableRuntime(file) ? ' (JSX)' : ''
        }: ${(err as Error).message}`
      )
    );
    this.callback(null, source, inputMap);
  }
}

export = runtimeLensLoader;
