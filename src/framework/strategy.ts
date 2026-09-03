import * as path from 'node:path';
import { requiresJsxCapableRuntime } from '../utils/paths';
import type { ProjectProfile } from './detect';

export type IntegrationKind = 'vite-plugin' | 'node-import-hook' | 'node-require-hook' | 'next-webpack-loader' | 'manual';

export interface RuntimeLensEnv {
  RUNTIME_LENS_PORT: string;
  RUNTIME_LENS_TOKEN: string;
  RUNTIME_LENS_HOST: string;
  RUNTIME_LENS_LABEL?: string;
  NODE_OPTIONS?: string;
}

export interface IntegrationStrategy {
  kind: IntegrationKind;
  title: string;
  /** One-paragraph explanation shown in the walkthrough/webview. */
  rationale: string;
  /** Environment variables the user's dev process needs. */
  env: RuntimeLensEnv;
  /** Ready-to-run shell command, when one exists. */
  command?: string;
  /** Code to paste, when the integration needs a config change. */
  snippet?: string;
  /** Extra warnings (e.g. server components, .tsx under bare node). */
  warnings: string[];
}

export interface StrategyContext {
  port: number;
  token: string;
  host?: string;
  /** Absolute path to the extension's `out` directory. */
  extensionOut: string;
  /** File the user is currently focused on, if any. */
  activeFile?: string;
}

function baseEnv(ctx: StrategyContext, label: string): RuntimeLensEnv {
  return {
    RUNTIME_LENS_PORT: String(ctx.port),
    RUNTIME_LENS_TOKEN: ctx.token,
    RUNTIME_LENS_HOST: ctx.host ?? '127.0.0.1',
    RUNTIME_LENS_LABEL: label
  };
}

function envPrefix(env: RuntimeLensEnv): string {
  return Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
}

function runScript(profile: ProjectProfile, script: string): string {
  switch (profile.packageManager) {
    case 'pnpm':
      return `pnpm ${script}`;
    case 'yarn':
      return `yarn ${script}`;
    case 'bun':
      return `bun run ${script}`;
    default:
      return `npm run ${script}`;
  }
}

/**
 * Map a detected project onto a concrete way of getting the agent into the
 * running process. There are exactly four mechanisms, and each framework maps
 * to the cheapest one that actually works:
 *
 *  - **Vite plugin**: a `transform` hook, so instrumentation happens in the
 *    same pass as esbuild/SWC and the source map chains correctly.
 *  - **Node `--import` hook**: `module.register()` load hooks for ESM.
 *  - **Node `--require` hook**: `Module._compile` patch for CJS.
 *  - **Next.js webpack loader**: Next owns its compiler; we register a loader
 *    through `next.config.*` instead of fighting SWC.
 *
 * A file that needs JSX support is *never* handed to bare Node - the strategy
 * downgrades to the bundler path and says why.
 */
export function selectStrategy(profile: ProjectProfile, ctx: StrategyContext): IntegrationStrategy {
  const warnings: string[] = [];
  const loaderDir = path.join(ctx.extensionOut, 'integrations');

  if (ctx.activeFile && requiresJsxCapableRuntime(ctx.activeFile) && profile.primary === 'node') {
    warnings.push(
      `${path.basename(ctx.activeFile)} contains JSX and cannot be executed by bare node; run it through your bundler or a JSX-aware runner.`
    );
  }

  switch (profile.primary) {
    case 'next-app':
    case 'next-pages':
    case 'next-hybrid': {
      const env = baseEnv(ctx, `next-dev (${profile.nextRouters.join('+') || 'pages'})`);
      warnings.push(
        'Server Components and Route Handlers run in the Node/edge runtime; client components run in the browser. Runtime Lens registers its loader for both compiler passes.'
      );
      if (profile.primary !== 'next-pages') {
        warnings.push('Values from `"use server"` code appear under the Node session, not the browser session.');
      }
      return {
        kind: 'next-webpack-loader',
        title: 'Next.js webpack loader',
        rationale:
          'Next.js compiles with its own SWC/webpack pipeline. Runtime Lens registers a webpack loader (client + server passes) from next.config.*, which keeps Next in charge of compilation while still giving us an AST pass over your own files only.',
        env,
        command: `${envPrefix(env)} ${runScript(profile, profile.scripts.dev ? 'dev' : 'start')}`,
        snippet: nextConfigSnippet(loaderDir, profile),
        warnings
      };
    }

    case 'vite':
    case 'react': {
      const env = baseEnv(ctx, 'vite-dev');
      return {
        kind: 'vite-plugin',
        title: 'Vite plugin',
        rationale:
          'Vite exposes a first-class `transform` hook, so Runtime Lens can instrument your modules before esbuild handles TS/JSX and return a source map that Vite chains with its own. The browser agent is served from a virtual module, so nothing is added to package.json.',
        env,
        command: `${envPrefix(env)} ${runScript(profile, profile.scripts.dev ? 'dev' : 'start')}`,
        snippet: viteConfigSnippet(loaderDir, profile),
        warnings
      };
    }

    case 'nestjs':
    case 'fastify':
    case 'express':
    case 'webpack':
    case 'node':
    default: {
      const isEsm = profile.moduleKind === 'esm';
      const hook = isEsm ? 'node-loader.mjs' : 'node-require.cjs';
      const flag = isEsm ? '--import' : '--require';
      const hookPath = path.join(loaderDir, hook);
      const env = baseEnv(ctx, `${profile.primary} (${profile.moduleKind})`);
      env.NODE_OPTIONS = `${flag} ${JSON.stringify(hookPath)}`;
      if (profile.typescript && profile.jsx) {
        warnings.push(
          'This project contains JSX. The Node hook transpiles .ts but refuses .tsx/.jsx, so component files must be instrumented through your bundler instead.'
        );
      }
      const target = profile.scripts.dev ? runScript(profile, 'dev') : profile.entry ? `node ${profile.entry}` : 'node .';
      return {
        kind: isEsm ? 'node-import-hook' : 'node-require-hook',
        title: isEsm ? 'Node ESM --import hook' : 'Node CJS --require hook',
        rationale: isEsm
          ? 'ESM cannot be patched after the fact, so Runtime Lens uses `module.register()` customization hooks via `--import`. The hook instruments source text in the `load` phase, before the module is linked.'
          : 'For CommonJS the cheapest correct hook is a `Module._compile` wrapper installed by `--require`: it sees the exact source Node is about to compile and returns instrumented code plus an inline source map.',
        env,
        command: `${envPrefix(env)} ${target}`,
        warnings
      };
    }
  }
}

export function nextConfigSnippet(loaderDir: string, profile: ProjectProfile): string {
  const loaderPath = path.join(loaderDir, 'webpack-loader.js').replace(/\\/g, '/');
  const ext = profile.configs.next ?? 'next.config.mjs';
  const isEsmConfig = ext.endsWith('.mjs') || ext.endsWith('.ts') || profile.moduleKind === 'esm';
  const body = `const nextConfig = {
  webpack(config) {
    config.module.rules.push({
      test: /\\.(js|jsx|ts|tsx)$/,
      exclude: /node_modules|\\.next/,
      use: [{ loader: ${JSON.stringify(loaderPath)} }],
      enforce: 'pre'
    });
    return config;
  }
};`;
  return isEsmConfig ? `${body}\n\nexport default nextConfig;\n` : `${body}\n\nmodule.exports = nextConfig;\n`;
}

export function viteConfigSnippet(loaderDir: string, profile: ProjectProfile): string {
  const pluginPath = path.join(loaderDir, 'vite-plugin.js').replace(/\\/g, '/');
  const isTs = profile.configs.vite?.endsWith('.ts') ?? profile.typescript;
  return `import { defineConfig } from 'vite';
import runtimeLens from ${JSON.stringify(pluginPath)};

export default defineConfig({
  plugins: [runtimeLens()]${isTs ? '' : ''}
});
`;
}
