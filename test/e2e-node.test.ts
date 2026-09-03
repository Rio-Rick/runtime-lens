import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RuntimeServer } from '../src/runtime/server';
import type { ExprEvent, LogEvent, RuntimeEvent } from '../src/protocol';
import { previewArgs } from '../src/serialization/preview';

const REPO = path.join(__dirname, '..', '..');
const OUT = path.join(REPO, 'out', 'src');
const FIXTURES = path.join(REPO, 'fixtures');
const TOKEN = 'e'.repeat(64);

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  events: RuntimeEvent[];
}

/**
 * Boot a real ingest server, run a real `node` process with the real hook, and
 * collect whatever the agent reports. This is the only test that proves the
 * whole pipeline (hook -> Babel transform -> agent -> transport -> server).
 */
async function runWithHook(
  entry: string,
  hook: { mode: '--require' | '--import'; file: string },
  cwd: string
): Promise<RunResult> {
  const server = new RuntimeServer({ token: TOKEN, maxPayloadBytes: 512 * 1024 });
  const { port } = await server.start();
  const events: RuntimeEvent[] = [];
  server.emitter.on('events', (payload) => events.push(...payload.events));

  try {
    const child = spawn(process.execPath, [hook.mode, hook.file, entry], {
      cwd,
      env: {
        ...process.env,
        RUNTIME_LENS_PORT: String(port),
        RUNTIME_LENS_TOKEN: TOKEN,
        RUNTIME_LENS_HOST: '127.0.0.1',
        RUNTIME_LENS_LABEL: 'e2e'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`child did not exit in time. stdout=${stdout} stderr=${stderr}`));
      }, 12_000);
      child.on('error', reject);
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    // The agent flushes on `beforeExit`; give the socket a moment to deliver.
    await new Promise((r) => setTimeout(r, 400));
    return { code, stdout, stderr, events };
  } finally {
    await server.stop();
  }
}

function logs(events: RuntimeEvent[]): LogEvent[] {
  return events.filter((e): e is LogEvent => e.t === 'log');
}

function texts(events: RuntimeEvent[]): string[] {
  return logs(events).map((e) => previewArgs(e.args, { maxLength: 400 }));
}

describe('end-to-end: real node process through the require hook (CJS + JS)', () => {
  let result: RunResult;

  before(async () => {
    result = await runWithHook(
      path.join(FIXTURES, 'node-js', 'index.js'),
      { mode: '--require', file: path.join(OUT, 'integrations', 'node-require.cjs') },
      path.join(FIXTURES, 'node-js')
    );
  });

  it('runs the program successfully and preserves its stdout', () => {
    assert.equal(result.code, 0, `child failed: ${result.stderr}`);
    assert.match(result.stdout, /cart loaded/, 'the original console output still reaches the terminal');
    assert.match(result.stdout, /totals computed/);
  });

  it('captures console calls from every level, across multiple files', () => {
    const captured = logs(result.events);
    assert.ok(captured.length >= 8, `expected >= 8 log events, got ${captured.length}`);
    const levels = new Set(captured.map((e) => e.level));
    for (const level of ['log', 'info', 'debug', 'warn', 'error', 'table']) {
      assert.ok(levels.has(level as LogEvent['level']), `missing level ${level}`);
    }
    const files = new Set(captured.map((e) => path.basename(e.loc.file)));
    assert.ok(files.has('index.js'), 'events from index.js');
    assert.ok(files.has('cart.js'), 'events from the required module too');
  });

  it('reports original source lines and multi-arg values', () => {
    const cartLoaded = logs(result.events).find((e) => previewArgs(e.args).startsWith('cart loaded'));
    assert.ok(cartLoaded, `no "cart loaded" event in: ${texts(result.events).join(' | ')}`);
    const source = fs.readFileSync(path.join(FIXTURES, 'node-js', 'index.js'), 'utf8').split('\n');
    assert.match(source[cartLoaded.loc.line - 1], /console\.log\('cart loaded'/, 'line number points at the real call');
    assert.equal(cartLoaded.args.length, 3, 'all three arguments are captured');
    assert.deepEqual(cartLoaded.args[1], { k: 'string', v: 'cart_1024', length: 9 });
    assert.deepEqual(cartLoaded.args[2], { k: 'number', v: 2 });
  });

  it('serializes Date, Map, Set and circular structures from a live process', () => {
    const totals = logs(result.events).find((e) => previewArgs(e.args).startsWith('totals computed'));
    assert.ok(totals);
    assert.equal(totals.args[1].k, 'object');

    const circular = logs(result.events).find((e) => previewArgs(e.args).startsWith('circular'));
    assert.ok(circular, 'expected the circular log');
    assert.match(JSON.stringify(circular.args), /"k":"circular"/);
  });

  it('counts repeated executions of the same probe', () => {
    const iterations = logs(result.events).filter((e) => previewArgs(e.args).startsWith('iteration'));
    assert.equal(iterations.length, 3);
    assert.deepEqual(iterations.map((e) => e.count), [1, 2, 3]);
    assert.equal(new Set(iterations.map((e) => e.id)).size, 1, 'one probe id for the loop body');
  });

  it('captures a `// ?` expression probe with its evaluated value', () => {
    const exprs = result.events.filter((e): e is ExprEvent => e.t === 'expr');
    assert.ok(exprs.length >= 1, 'expected at least one expression probe');
    const totals = exprs.find((e) => e.expr.includes('totals'));
    assert.ok(totals, `probes were: ${exprs.map((e) => e.expr).join(', ')}`);
    assert.equal(totals.value.k, 'object');
    assert.match(JSON.stringify(totals.value), /subtotal/);
  });

  it('captures a caught error object logged via console.error', () => {
    const errors = logs(result.events).filter((e) => e.level === 'error');
    assert.ok(errors.length >= 1);
    assert.match(JSON.stringify(errors[0].args), /"k":"error"/);
    assert.match(JSON.stringify(errors[0].args), /SyntaxError|JSON/);
  });

  it('never instruments node_modules', () => {
    for (const event of result.events) {
      assert.ok(!event.loc.file.includes('node_modules'), event.loc.file);
    }
  });
});

describe('end-to-end: real node process through the --import hook (ESM + TypeScript)', () => {
  let result: RunResult;

  before(async () => {
    result = await runWithHook(
      path.join(FIXTURES, 'node-ts', 'src', 'index.ts'),
      { mode: '--import', file: path.join(OUT, 'integrations', 'node-loader.mjs') },
      path.join(FIXTURES, 'node-ts')
    );
  });

  it('executes a .ts ESM entry point with types stripped', () => {
    assert.equal(result.code, 0, `child failed: ${result.stderr}`);
    assert.match(result.stdout, /order ord_77/);
  });

  it('captures values from .ts files and maps them to original .ts lines', () => {
    const captured = logs(result.events);
    assert.ok(captured.length >= 3, `got ${captured.length}: ${texts(result.events).join(' | ')}`);
    const orderLog = captured.find((e) => previewArgs(e.args).startsWith('order'));
    assert.ok(orderLog);
    assert.ok(orderLog.loc.file.endsWith('index.ts'), orderLog.loc.file);
    const source = fs.readFileSync(path.join(FIXTURES, 'node-ts', 'src', 'index.ts'), 'utf8').split('\n');
    assert.match(source[orderLog.loc.line - 1], /console\.log\('order'/);
  });

  it('captures across imported .ts modules', () => {
    const files = new Set(logs(result.events).map((e) => path.basename(e.loc.file)));
    assert.ok(files.has('pricing.ts'), `files seen: ${[...files].join(', ')}`);
  });

  it('serializes a Map with BigInt values from a real process', () => {
    const registry = logs(result.events).find((e) => previewArgs(e.args).startsWith('registry'));
    assert.ok(registry);
    assert.equal(registry.args[1].k, 'map');
    assert.match(JSON.stringify(registry.args[1]), /"k":"bigint"/);
  });

  it('captures expression probes in TypeScript', () => {
    const exprs = result.events.filter((e): e is ExprEvent => e.t === 'expr');
    assert.ok(exprs.length >= 2, `expected probes from index.ts and pricing.ts, got ${exprs.length}`);
    assert.ok(exprs.some((e) => e.expr.includes('total')));
  });
});

describe('end-to-end: guardrails', () => {
  it('refuses to run a .tsx file through bare node with an actionable message', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl-tsx-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(
      path.join(dir, 'view.tsx'),
      "export const V = () => <div>{console.log('hi') as unknown as null}</div>;\nconsole.log('module loaded');\n"
    );
    fs.writeFileSync(path.join(dir, 'main.mjs'), "await import('./view.tsx');\n");

    const result = await runWithHook(
      path.join(dir, 'main.mjs'),
      { mode: '--import', file: path.join(OUT, 'integrations', 'node-loader.mjs') },
      dir
    );
    assert.notEqual(result.code, 0, 'the process must fail rather than silently mis-execute JSX');
    assert.match(result.stderr, /jsx|tsx|bundler/i, `unhelpful error: ${result.stderr}`);
  });

  it('runs the program untouched when no endpoint is configured', async () => {
    const child = spawn(
      process.execPath,
      ['--require', path.join(OUT, 'integrations', 'node-require.cjs'), path.join(FIXTURES, 'node-js', 'index.js')],
      { cwd: path.join(FIXTURES, 'node-js'), env: { ...process.env, RUNTIME_LENS_PORT: '', RUNTIME_LENS_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, stderr);
    assert.match(stdout, /cart loaded/, 'with no editor listening, the program behaves exactly as before');
  });
});
