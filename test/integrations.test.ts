import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import runtimeLensVite = require('../src/integrations/vite-plugin');
import webpackLoader = require('../src/integrations/webpack-loader');

const REPO = path.join(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'fixtures');
const TOKEN = 'v'.repeat(64);

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('integrations/vite-plugin', () => {
  const appFile = path.join(FIXTURES, 'react-vite', 'src', 'App.tsx');
  const appSource = fs.readFileSync(appFile, 'utf8');

  it('is a serve-only pre plugin so production builds are never touched', () => {
    const plugin = runtimeLensVite({ port: 1234, token: TOKEN });
    assert.equal(plugin.name, 'runtime-lens');
    assert.equal(plugin.enforce, 'pre');
    assert.equal(plugin.apply, 'serve');
  });

  it('instruments a real .tsx fixture and returns a source map', () => {
    const plugin = runtimeLensVite({ port: 1234, token: TOKEN });
    const result = plugin.transform(appSource, appFile);
    assert.ok(result, 'the plugin must transform a JSX component');
    assert.match(result.code, /virtual:runtime-lens-agent/, 'the agent import is injected');
    assert.match(result.code, /\.c\(/, 'console calls are rewritten into probe calls');
    assert.match(result.code, /<[A-Za-z]/, 'JSX is preserved for esbuild to compile');
    assert.ok(result.map, 'a source map is handed back for Vite to chain');
    assert.equal((result.map as { version: number }).version, 3);
  });

  it('tolerates bundler query suffixes on module ids', () => {
    const plugin = runtimeLensVite({ port: 1234, token: TOKEN });
    const result = plugin.transform(appSource, `${appFile}?t=1712345`);
    assert.ok(result, 'ids with a query string are still instrumented');
  });

  it('never instruments node_modules or generated output', () => {
    const plugin = runtimeLensVite({ port: 1234, token: TOKEN });
    for (const id of [
      '/p/node_modules/react/index.js',
      '/p/dist/assets/index-abc.js',
      '/p/.next/static/x.js',
      '\0virtual:runtime-lens-agent'
    ]) {
      assert.equal(plugin.transform("console.log('x');\n", id), undefined, id);
    }
  });

  it('honours extra excludes and the ssr opt-out', () => {
    const plugin = runtimeLensVite({ port: 1234, token: TOKEN, exclude: ['generated'], ssr: false });
    assert.equal(plugin.transform("console.log(1);\n", '/p/generated/a.ts'), undefined);
    assert.equal(plugin.transform("console.log(1);\n", '/p/src/a.ts', { ssr: true }), undefined);
    assert.ok(plugin.transform("console.log(1);\n", '/p/src/a.ts', { ssr: false }));
  });

  it('is inert (and injects a no-op agent) when no editor endpoint is configured', () => {
    withEnv({ RUNTIME_LENS_PORT: undefined, RUNTIME_LENS_TOKEN: undefined }, () => {
      const plugin = runtimeLensVite();
      assert.equal(plugin.transform(appSource, appFile), undefined, 'no port/token means no rewriting at all');
      const virtual = plugin.load('\0virtual:runtime-lens-agent');
      assert.ok(virtual);
      assert.match(virtual, /console\[l\]/, 'the fallback agent still forwards to the real console');
    });
  });

  it('reads its configuration from the environment when called with no options', () => {
    withEnv({ RUNTIME_LENS_PORT: '5510', RUNTIME_LENS_TOKEN: TOKEN, RUNTIME_LENS_HOST: '127.0.0.1' }, () => {
      const plugin = runtimeLensVite();
      assert.ok(plugin.transform(appSource, appFile), 'env configuration enables the plugin');
    });
  });

  it('resolves and loads the virtual agent module with the browser agent bundle inlined', () => {
    const plugin = runtimeLensVite({ port: 4321, token: TOKEN, objectDepth: 5 });
    assert.equal(plugin.resolveId('virtual:runtime-lens-agent'), '\0virtual:runtime-lens-agent');
    assert.equal(plugin.resolveId('react'), undefined);
    const code = plugin.load('\0virtual:runtime-lens-agent');
    assert.ok(code, 'the virtual module must resolve to real code');
    assert.match(code, /__RUNTIME_LENS_CONFIG__/);
    assert.match(code, /"port":4321/);
    assert.match(code, /"objectDepth":5/);
    assert.match(code, /export/, 'the bundled browser agent is an ES module');
    assert.equal(plugin.load('/p/src/App.tsx'), undefined, 'other ids are left alone');
  });

  it('delegates the SSR pass to the node agent instead of the browser bundle', () => {
    const plugin = runtimeLensVite({ port: 4321, token: TOKEN });
    const code = plugin.load('\0virtual:runtime-lens-agent', { ssr: true });
    assert.ok(code);
    assert.match(code, /createRequire/);
    assert.match(code, /node-agent\.js/);
  });
});

describe('integrations/webpack-loader (Next.js)', () => {
  const pageFile = path.join(FIXTURES, 'next-pages', 'pages', 'index.tsx');
  const pageSource = fs.readFileSync(pageFile, 'utf8');

  interface LoaderCalls {
    code?: string;
    map?: unknown;
    error?: unknown;
  }

  function runLoader(source: string, resourcePath: string, options: Record<string, unknown>): LoaderCalls {
    const calls: LoaderCalls = {};
    const context = {
      resourcePath,
      cacheable(): void {
        /* webpack api */
      },
      getOptions(): Record<string, unknown> {
        return options;
      },
      callback(error: unknown, code?: string, map?: unknown): void {
        calls.error = error;
        calls.code = code;
        calls.map = map;
      }
    };
    webpackLoader.call(context as never, source, undefined);
    return calls;
  }

  it('instruments a Next.js page and keeps JSX for the Next compiler', () => {
    const result = runLoader(pageSource, pageFile, { port: 7777, token: TOKEN });
    assert.equal(result.error, null);
    assert.ok(result.code);
    assert.match(result.code, /\.c\(/);
    assert.match(result.code, /<main|<div|<section|<Layout/i, 'JSX survives for SWC to compile');
    assert.ok(result.map, 'the loader chains a source map');
  });

  it('passes through files it must not touch', () => {
    for (const file of ['/p/node_modules/next/dist/x.js', '/p/.next/server/pages/index.js']) {
      const result = runLoader("console.log('x');\n", file, { port: 7777, token: TOKEN });
      assert.equal(result.code, "console.log('x');\n", file);
    }
  });

  it('passes through unchanged when it has no endpoint', () => {
    withEnv({ RUNTIME_LENS_PORT: undefined, RUNTIME_LENS_TOKEN: undefined }, () => {
      const result = runLoader(pageSource, pageFile, {});
      assert.equal(result.code, pageSource, 'without a port/token the loader is a no-op');
    });
  });

  it('never fails the build: a parse error degrades to the original source', () => {
    const result = runLoader('const = = = broken(((;\n', path.join(FIXTURES, 'next-pages', 'pages', 'bad.ts'), {
      port: 7777,
      token: TOKEN
    });
    assert.equal(result.error, null, 'the loader must not surface an error to webpack');
    assert.equal(result.code, 'const = = = broken(((;\n');
  });
});

describe('package manifest integrity', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as {
    name: string;
    publisher: string;
    main: string;
    engines: { vscode: string };
    activationEvents: string[];
    scripts: Record<string, string>;
    contributes: {
      commands: Array<{ command: string; title: string; category?: string; icon?: unknown }>;
      configuration: { properties: Record<string, { type: string; default: unknown; description: string }> };
      views: Record<string, Array<{ id: string; name: string }>>;
      viewsContainers: { activitybar: Array<{ id: string; title: string; icon: string }> };
      menus?: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    };
  };

  it('declares the identity the task requires', () => {
    assert.equal(pkg.name, 'runtime-lens');
    assert.equal(pkg.publisher, 'runtime-lens');
    assert.equal(pkg.engines.vscode, '^1.85.0');
    assert.equal(pkg.main, './out/src/extension.js');
    assert.ok(fs.existsSync(path.join(REPO, 'out', 'src', 'extension.js')), 'main must point at a compiled file');
  });

  it('has compile, watch, test and package scripts', () => {
    for (const script of ['compile', 'watch', 'test', 'package']) {
      assert.ok(pkg.scripts[script], `missing script: ${script}`);
    }
  });

  it('contributes every required command with a title', () => {
    const required = [
      'runtimeLens.start',
      'runtimeLens.stop',
      'runtimeLens.restart',
      'runtimeLens.clearLogs',
      'runtimeLens.pauseCapture',
      'runtimeLens.resumeCapture',
      'runtimeLens.showRuntimeExplorer',
      'runtimeLens.toggleInlineValues',
      'runtimeLens.showDiagnostics'
    ];
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const id of required) {
      assert.ok(declared.has(id), `command not contributed: ${id}`);
    }
    for (const command of pkg.contributes.commands) {
      assert.ok(command.title.length > 0, `${command.command} needs a title`);
      assert.ok(command.command.startsWith('runtimeLens.'), command.command);
    }
  });

  it('contributes every required setting with a documented default', () => {
    const required: Record<string, string> = {
      'runtimeLens.enabled': 'boolean',
      'runtimeLens.inlineValues': 'boolean',
      'runtimeLens.captureConsole': 'boolean',
      'runtimeLens.captureExpressions': 'boolean',
      'runtimeLens.maxInlineLength': 'number',
      'runtimeLens.objectDepth': 'number',
      'runtimeLens.maxHistory': 'number',
      'runtimeLens.showTimestamp': 'boolean',
      'runtimeLens.showExecutionCount': 'boolean'
    };
    const properties = pkg.contributes.configuration.properties;
    for (const [key, type] of Object.entries(required)) {
      const property = properties[key];
      assert.ok(property, `missing setting: ${key}`);
      assert.equal(property.type, type, key);
      assert.notEqual(property.default, undefined, `${key} needs a default`);
      assert.ok(property.description.length > 10, `${key} needs a real description`);
    }
  });

  it('contributes the Runtime Lens view and its container', () => {
    const container = pkg.contributes.viewsContainers.activitybar.find((c) => c.id === 'runtimeLens');
    assert.ok(container, 'the activity bar container is missing');
    assert.ok(fs.existsSync(path.join(REPO, container.icon)), `icon not found: ${container.icon}`);
    const views = pkg.contributes.views[container.id];
    assert.ok(views && views.length > 0);
    assert.ok(views.some((v) => v.id === 'runtimeLens.explorer'));
  });

  it('only references commands it contributes from its menus', () => {
    const declared = new Set(pkg.contributes.commands.map((c) => c.command));
    for (const [menu, items] of Object.entries(pkg.contributes.menus ?? {})) {
      for (const item of items) {
        assert.ok(declared.has(item.command), `${menu} references unknown command ${item.command}`);
      }
    }
  });

  it('ships the assets the runtime needs and excludes the ones it does not', () => {
    for (const asset of [
      'out/src/integrations/node-require.cjs',
      'out/src/integrations/node-loader.mjs',
      'out/src/integrations/node-hooks.mjs',
      'out/src/agent/browser-agent.mjs',
      'out/src/webview/media/main.js',
      'out/src/webview/media/style.css'
    ]) {
      assert.ok(fs.existsSync(path.join(REPO, asset)), `build artifact missing: ${asset}`);
    }
    const ignore = fs.readFileSync(path.join(REPO, '.vscodeignore'), 'utf8');
    for (const pattern of ['out/test/**', 'fixtures/**', 'src/**', 'test/**']) {
      assert.ok(ignore.includes(pattern), `.vscodeignore should exclude ${pattern}`);
    }
  });
});
