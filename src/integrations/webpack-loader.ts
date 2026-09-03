import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { instrument } from '../instrumentation/transform';
import { requiresJsxCapableRuntime, shouldInstrument } from '../utils/paths';

interface MinimalLoaderContext {
  resourcePath: string;
  target?: string;
  cacheable?: (flag: boolean) => void;
  callback: (err: Error | null, code?: string, map?: unknown) => void;
  emitWarning?: (warning: Error) => void;
  getOptions?: () => Record<string, unknown>;
}

/**
 * Materialise a configured browser agent on disk.
 *
 * A webpack client bundle has no access to `process.env`, so the port/token
 * have to be baked into a module. We write one file per port under the OS temp
 * directory and let webpack bundle it like any other source file.
 */
function ensureConfiguredBrowserAgent(port: number, token: string, host: string, depth: number): string {
  const dir = path.join(os.tmpdir(), 'runtime-lens');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `browser-agent-${port}.mjs`);
  const source = fs.readFileSync(path.join(__dirname, '..', 'agent', 'browser-agent.mjs'), 'utf8');
  const header = `globalThis.__RUNTIME_LENS_CONFIG__ = ${JSON.stringify({
    port,
    token,
    host,
    runtime: 'browser',
    objectDepth: depth
  })};\n`;
  const contents = header + source;
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {
    existing = undefined;
  }
  if (existing !== contents) {
    fs.writeFileSync(target, contents, 'utf8');
  }
  return target;
}

/**
 * Webpack loader used for Next.js (client and server compiler passes).
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

  const isBrowserTarget = this.target === undefined || this.target === 'web' || this.target === 'webworker';
  let agentModule: string;
  try {
    agentModule = isBrowserTarget
      ? ensureConfiguredBrowserAgent(port, token, host, depth)
      : path.join(__dirname, '..', 'agent', 'node-agent.js');
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
