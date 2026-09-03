/**
 * Node ESM entry hook. Used as `node --import <this file> app.mjs`.
 *
 * `--import` runs this file in the main thread before the entry module is
 * evaluated, which is the only supported way to install ESM customization
 * hooks (`module.register`) as of Node 20.6+.
 * Docs: https://nodejs.org/api/module.html#customization-hooks
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// CommonJS dependencies of an ESM app still go through require(), so install
// the require hook too. Both hooks share one transform implementation.
try {
  require('./node-require.cjs');
} catch (err) {
  process.emitWarning(`runtime-lens: could not install CJS hook: ${err && err.message}`);
}

try {
  register(new URL('./node-hooks.mjs', import.meta.url), pathToFileURL('./'));
} catch (err) {
  process.emitWarning(`runtime-lens: could not register ESM hooks: ${err && err.message}`);
}
