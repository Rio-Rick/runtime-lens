/**
 * CommonJS require hook. Used as `node --require <this file> app.js`.
 *
 * Wrapping `Module.prototype._compile` is the least invasive correct place to
 * hook CJS: we see exactly the source Node is about to compile, we can return
 * instrumented source with an inline source map, and we do not have to
 * duplicate Node's resolution algorithm.
 */
'use strict';

const Module = require('module');
const path = require('path');
const fs = require('fs');

const { instrument } = require('../instrumentation/transform.js');
const { appendInlineSourceMap } = require('../instrumentation/source-maps.js');
const { shouldInstrument, requiresJsxCapableRuntime } = require('../utils/paths.js');

const AGENT_MODULE = path.join(__dirname, '..', 'agent', 'node-agent.js');
const GUARD = '__runtimeLensRequireHookInstalled';

if (!global[GUARD]) {
  global[GUARD] = true;

  const originalCompile = Module.prototype._compile;

  Module.prototype._compile = function runtimeLensCompile(content, filename) {
    let source = content;
    if (shouldInstrument(filename) && !requiresJsxCapableRuntime(filename)) {
      try {
        const out = instrument(content, {
          filename,
          agentModule: AGENT_MODULE,
          moduleKind: 'cjs',
          sourceMaps: true,
          stripTypes: /\.[cm]?ts$/i.test(filename)
        });
        if (!out.skipped) {
          source = appendInlineSourceMap(out.code, out.map);
        }
      } catch (err) {
        process.emitWarning(`runtime-lens: instrumentation failed for ${filename}: ${err && err.message}`);
      }
    }
    return originalCompile.call(this, source, filename);
  };

  // Teach CJS how to require .ts files (types stripped by Babel).
  const compileTs = (module_, filename) => {
    const source = fs.readFileSync(filename, 'utf8');
    module_._compile(stripTypes(source, filename), filename);
  };
  require.extensions['.ts'] = compileTs;
  require.extensions['.cts'] = compileTs;
  require.extensions['.tsx'] = function refuseTsx(_module, filename) {
    throw new Error(
      `runtime-lens: ${path.basename(filename)} contains JSX and cannot be required by bare node. ` +
        `Instrument it through Vite/Next instead.`
    );
  };
}

function stripTypes(source, filename) {
  const babel = require('@babel/core');
  const result = babel.transformSync(source, {
    filename,
    configFile: false,
    babelrc: false,
    sourceMaps: 'inline',
    sourceType: 'unambiguous',
    plugins: [
      [require.resolve('@babel/plugin-transform-typescript'), { isTSX: false, allowDeclareFields: true }],
      require.resolve('@babel/plugin-transform-modules-commonjs')
    ],
    parserOpts: { plugins: ['typescript', 'classProperties', 'decorators-legacy'] }
  });
  return result && result.code ? result.code : source;
}
