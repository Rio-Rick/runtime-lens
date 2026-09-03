/**
 * ESM `load`/`resolve` customization hooks.
 *
 * These run on a dedicated hooks thread, so they must not touch the app's
 * module graph - only read source text, instrument it, and hand it back.
 */
import { createRequire, } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { instrument } = require('../instrumentation/transform.js');
const { appendInlineSourceMap } = require('../instrumentation/source-maps.js');
const { shouldInstrument, requiresJsxCapableRuntime } = require('../utils/paths.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT_MODULE = path.join(here, '..', 'agent', 'node-agent.js');
const TS_EXTENSIONS = new Set(['.ts', '.mts', '.cts']);

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Allow `import './mod.js'` to resolve to `./mod.ts`, and extensionless
    // relative imports to find a TypeScript file, matching what bundlers do.
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
      throw err;
    }
    const parentPath = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const base = path.resolve(parentPath, specifier);
    const candidates = [
      base.replace(/\.js$/, '.ts'),
      base.replace(/\.mjs$/, '.mts'),
      `${base}.ts`,
      `${base}.mts`,
      path.join(base, 'index.ts')
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return { url: new URL(`file://${candidate.replace(/\\/g, '/')}`).href, format: 'module', shortCircuit: true };
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file://')) {
    return nextLoad(url, context);
  }
  const filePath = fileURLToPath(url);
  const ext = path.extname(filePath).toLowerCase();

  if (requiresJsxCapableRuntime(filePath)) {
    throw new Error(
      `runtime-lens: ${path.basename(filePath)} contains JSX and cannot be executed by bare node. ` +
        `Run it through Vite/Next (Runtime Lens instruments those pipelines) or a JSX-aware runner.`
    );
  }

  const isTs = TS_EXTENSIONS.has(ext);
  if (!shouldInstrument(filePath)) {
    return isTs ? loadTypeScriptOnly(filePath) : nextLoad(url, context);
  }

  let source;
  if (isTs) {
    source = fs.readFileSync(filePath, 'utf8');
  } else {
    const result = await nextLoad(url, { ...context, format: context.format ?? 'module' });
    source = typeof result.source === 'string' ? result.source : Buffer.from(result.source ?? '').toString('utf8');
    if (result.format === 'commonjs' || result.format === 'json' || result.format === 'wasm') {
      return result;
    }
  }

  try {
    const out = instrument(source, {
      filename: filePath,
      agentModule: AGENT_MODULE,
      moduleKind: 'esm',
      sourceMaps: true,
      stripTypes: isTs
    });
    if (out.skipped) {
      return isTs ? loadTypeScriptOnly(filePath, source) : { format: 'module', source, shortCircuit: true };
    }
    return { format: 'module', source: appendInlineSourceMap(out.code, out.map), shortCircuit: true };
  } catch (err) {
    process.emitWarning(`runtime-lens: instrumentation failed for ${filePath}: ${err && err.message}`);
    return isTs ? loadTypeScriptOnly(filePath, source) : { format: 'module', source, shortCircuit: true };
  }
}

/** Strip types without instrumenting (excluded files still need to run). */
function loadTypeScriptOnly(filePath, sourceText) {
  const source = sourceText ?? fs.readFileSync(filePath, 'utf8');
  const out = instrument(source, {
    filename: filePath,
    agentModule: AGENT_MODULE,
    moduleKind: 'esm',
    captureConsole: false,
    captureExpressions: false,
    sourceMaps: true,
    stripTypes: true
  });
  // `instrument` returns the input untouched when it skips, so fall back to a
  // types-only Babel pass in that case.
  if (out.skipped) {
    const babel = require('@babel/core');
    const transformed = babel.transformSync(source, {
      filename: filePath,
      configFile: false,
      babelrc: false,
      sourceMaps: 'inline',
      plugins: [[require.resolve('@babel/plugin-transform-typescript'), { isTSX: false }]],
      parserOpts: { plugins: ['typescript'] }
    });
    return { format: 'module', source: transformed?.code ?? source, shortCircuit: true };
  }
  return { format: 'module', source: appendInlineSourceMap(out.code, out.map), shortCircuit: true };
}
