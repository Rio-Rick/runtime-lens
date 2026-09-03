import * as fs from 'node:fs';
import * as path from 'node:path';
import { instrument } from '../instrumentation/transform';
import { shouldInstrument } from '../utils/paths';

const VIRTUAL_ID = 'virtual:runtime-lens-agent';
const RESOLVED_VIRTUAL_ID = `\0${VIRTUAL_ID}`;

interface RuntimeLensViteOptions {
  port?: number;
  token?: string;
  host?: string;
  captureConsole?: boolean;
  captureExpressions?: boolean;
  objectDepth?: number;
  /** Extra directory names to exclude, on top of the built-in list. */
  exclude?: string[];
  /** Instrument SSR passes as well (default true). */
  ssr?: boolean;
}

interface MinimalVitePlugin {
  name: string;
  enforce?: 'pre' | 'post';
  apply?: 'serve' | 'build';
  resolveId(this: unknown, id: string): string | undefined;
  load(this: unknown, id: string, options?: { ssr?: boolean }): string | undefined;
  transform(
    this: unknown,
    code: string,
    id: string,
    options?: { ssr?: boolean }
  ): { code: string; map: unknown } | undefined;
}

/**
 * Vite plugin.
 *
 * `enforce: 'pre'` puts us ahead of esbuild's TS/JSX handling, which means we
 * parse the developer's *original* source (so `// ?` probes and comments are
 * intact and probe ids match what the editor computed) and hand Vite a source
 * map that it chains with the rest of the pipeline.
 *
 * `apply: 'serve'` guarantees we never end up in a production build.
 */
function runtimeLensVite(options: RuntimeLensViteOptions = {}): MinimalVitePlugin {
  const port = options.port ?? Number.parseInt(process.env.RUNTIME_LENS_PORT ?? '', 10);
  const token = options.token ?? process.env.RUNTIME_LENS_TOKEN ?? '';
  const host = options.host ?? process.env.RUNTIME_LENS_HOST ?? '127.0.0.1';
  const enabled = Number.isInteger(port) && port > 0 && token.length > 0;

  const browserAgentPath = path.join(__dirname, '..', 'agent', 'browser-agent.mjs');
  const nodeAgentPath = path.join(__dirname, '..', 'agent', 'node-agent.js');

  return {
    name: 'runtime-lens',
    enforce: 'pre',
    apply: 'serve',

    resolveId(id: string): string | undefined {
      return id === VIRTUAL_ID ? RESOLVED_VIRTUAL_ID : undefined;
    },

    load(id: string, loadOptions?: { ssr?: boolean }): string | undefined {
      if (id !== RESOLVED_VIRTUAL_ID) {
        return undefined;
      }
      if (!enabled) {
        return 'export default { c(l, i, f, n, c2, a) { console[l] && console[l](...a); }, e(i, f, n, c2, x, v) { return v; } };\n';
      }
      if (loadOptions?.ssr) {
        // The SSR pass runs in Node, where the browser agent's WebSocket may
        // not exist; delegate to the Node agent through createRequire.
        return [
          `import { createRequire as __rlCreateRequire } from 'node:module';`,
          `const __rlRequire = __rlCreateRequire(import.meta.url);`,
          `export default __rlRequire(${JSON.stringify(nodeAgentPath)});`,
          ''
        ].join('\n');
      }
      const config = {
        port,
        token,
        host,
        runtime: 'browser' as const,
        objectDepth: options.objectDepth ?? 3
      };
      const agentSource = fs.readFileSync(browserAgentPath, 'utf8');
      return `globalThis.__RUNTIME_LENS_CONFIG__ = ${JSON.stringify(config)};\n${agentSource}`;
    },

    transform(code: string, id: string, transformOptions?: { ssr?: boolean }): { code: string; map: unknown } | undefined {
      if (!enabled) {
        return undefined;
      }
      if (transformOptions?.ssr && options.ssr === false) {
        return undefined;
      }
      const file = id.split('?')[0];
      if (!shouldInstrument(file, { extraExcludes: options.exclude })) {
        return undefined;
      }
      const result = instrument(code, {
        filename: file,
        agentModule: VIRTUAL_ID,
        moduleKind: 'esm',
        captureConsole: options.captureConsole ?? true,
        captureExpressions: options.captureExpressions ?? true,
        sourceMaps: true
      });
      if (result.skipped) {
        return undefined;
      }
      return { code: result.code, map: result.map };
    }
  };
}

export = runtimeLensVite;
