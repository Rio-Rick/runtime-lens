/**
 * Node entry point required/imported by instrumented files.
 *
 * `export =` is intentional: the transform injects `require("<this file>")`
 * (CJS) or `import __rlAgent from "<this file>"` (ESM), and both must yield
 * the agent object itself rather than a `{ default: ... }` wrapper.
 */
import { createNoopAgent } from './core';
import { createNodeAgent, readNodeEndpointFromEnv } from './node-transport';

const endpoint = readNodeEndpointFromEnv();

const agent = endpoint
  ? createNodeAgent({ endpoint, label: process.env.RUNTIME_LENS_LABEL || undefined })
  : createNoopAgent();

export = agent;
