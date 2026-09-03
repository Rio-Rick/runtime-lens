import * as path from 'node:path';
import { transformSync, type PluginObj, type PluginPass, type TransformOptions } from '@babel/core';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { LOG_LEVELS, type LogLevel } from '../protocol';
import { computeProbeId } from '../utils/probe-id';
import { shouldInstrument } from '../utils/paths';

/** Marker comment written into every transformed file to make the transform idempotent. */
export const INSTRUMENTED_MARKER = 'runtime-lens:instrumented';

/** Comment probe syntax: `someExpression; // ?` (also accepts `//?` and `// ?.path`). */
const PROBE_COMMENT = /^\s*\??\s*\?\s*$|^\s*\?\s*$/;

export interface TransformOptionsRL {
  /** Absolute path of the file being transformed (used for ids + locations). */
  filename: string;
  /**
   * Module specifier the injected prelude imports/requires to reach the agent.
   * Absolute path for Node, a resolvable id for bundlers.
   */
  agentModule: string;
  /** `esm` emits `import`, `cjs` emits `require`. `auto` sniffs the source. */
  moduleKind?: 'esm' | 'cjs' | 'auto';
  /** Capture console.* calls. */
  captureConsole?: boolean;
  /** Capture `// ?` expression probes. */
  captureExpressions?: boolean;
  /** Emit a source map (inline base64 or separate object). */
  sourceMaps?: boolean | 'inline';
  /** Strip TypeScript types (needed when handing the output to bare Node). */
  stripTypes?: boolean;
  /** Root used to make ids stable across machines. */
  projectRoot?: string;
}

export interface TransformResult {
  code: string;
  map: unknown;
  /** Probes discovered in this file, for editor-side bookkeeping. */
  probes: ProbeRecord[];
  /** True when the file was left untouched (excluded, already done, or no probes). */
  skipped: boolean;
  reason?: string;
}

export interface ProbeRecord {
  id: string;
  kind: 'log' | 'expr';
  level?: LogLevel;
  file: string;
  line: number;
  column: number;
  text: string;
}

export function parserPluginsFor(filename: string): NonNullable<TransformOptions['parserOpts']>['plugins'] {
  const ext = path.extname(filename).toLowerCase();
  const common = [
    'classProperties',
    'classPrivateProperties',
    'classPrivateMethods',
    'objectRestSpread',
    'optionalChaining',
    'nullishCoalescingOperator',
    'dynamicImport',
    'topLevelAwait',
    'importMeta',
    'decorators-legacy',
    'explicitResourceManagement'
  ] as const;
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    return ['typescript', ...common] as NonNullable<TransformOptions['parserOpts']>['plugins'];
  }
  if (ext === '.tsx') {
    return ['typescript', 'jsx', ...common] as NonNullable<TransformOptions['parserOpts']>['plugins'];
  }
  return ['jsx', ...common] as NonNullable<TransformOptions['parserOpts']>['plugins'];
}

function sniffModuleKind(code: string, filename: string): 'esm' | 'cjs' {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.mjs' || ext === '.mts') {
    return 'esm';
  }
  if (ext === '.cjs' || ext === '.cts') {
    return 'cjs';
  }
  if (/^\s*(import|export)\s/m.test(code) || /\bimport\s*\(/.test(code) || /\bimport\.meta\b/.test(code)) {
    return 'esm';
  }
  if (/\b(require|module\.exports|exports\.)\b/.test(code)) {
    return 'cjs';
  }
  return 'esm';
}

interface PluginState extends PluginPass {
  rlAgentId?: t.Identifier;
  rlFileId?: t.Identifier;
  rlProbes?: ProbeRecord[];
  rlTouched?: boolean;
}

/**
 * The Babel plugin. This is an AST transform - there is no regular expression
 * anywhere in the rewrite path. Regex-based instrumentation breaks on strings
 * containing `console.log(`, on template literals, on JSX text and on comments;
 * an AST pass cannot.
 */
function createPlugin(opts: Required<Pick<TransformOptionsRL, 'captureConsole' | 'captureExpressions'>> & {
  filename: string;
  idFile: string;
  agentModule: string;
  moduleKind: 'esm' | 'cjs';
  probes: ProbeRecord[];
  source: string;
}): PluginObj<PluginState> {
  const ourCalls = new WeakSet<t.Node>();

  const probeText = (node: t.Node): string => {
    if (typeof node.start === 'number' && typeof node.end === 'number') {
      return opts.source.slice(node.start, node.end);
    }
    return '<expr>';
  };

  const hasProbeComment = (node: t.Node): boolean => {
    const comments = [...(node.trailingComments ?? []), ...(node.leadingComments ?? [])];
    return comments.some((c) => c.type === 'CommentLine' && PROBE_COMMENT.test(c.value));
  };

  return {
    name: 'runtime-lens',
    visitor: {
      Program: {
        enter(programPath, state) {
          state.rlAgentId = programPath.scope.generateUidIdentifier('rlAgent');
          state.rlFileId = programPath.scope.generateUidIdentifier('rlFile');
          state.rlProbes = opts.probes;
        },
        exit(programPath, state) {
          if (!state.rlTouched) {
            return;
          }
          const agentId = state.rlAgentId as t.Identifier;
          const fileId = state.rlFileId as t.Identifier;

          const fileConst = t.variableDeclaration('const', [
            t.variableDeclarator(fileId, t.stringLiteral(opts.filename))
          ]);

          let prelude: t.Statement;
          if (opts.moduleKind === 'esm') {
            prelude = t.importDeclaration(
              [t.importDefaultSpecifier(agentId)],
              t.stringLiteral(opts.agentModule)
            );
          } else {
            prelude = t.variableDeclaration('const', [
              t.variableDeclarator(
                agentId,
                t.callExpression(t.identifier('require'), [t.stringLiteral(opts.agentModule)])
              )
            ]);
          }
          t.addComment(prelude, 'leading', ` ${INSTRUMENTED_MARKER} `, false);
          programPath.unshiftContainer('body', [prelude, fileConst]);
        }
      },

      CallExpression(callPath, state) {
        if (!opts.captureConsole || ourCalls.has(callPath.node)) {
          return;
        }
        const callee = callPath.node.callee;
        if (!t.isMemberExpression(callee) || callee.computed) {
          return;
        }
        if (!t.isIdentifier(callee.object, { name: 'console' })) {
          return;
        }
        // Respect shadowing: a local `const console = {...}` is not the global.
        if (callPath.scope.hasBinding('console', { noGlobals: true })) {
          return;
        }
        if (!t.isIdentifier(callee.property)) {
          return;
        }
        const level = callee.property.name;
        if (!LOG_LEVELS.includes(level as LogLevel)) {
          return;
        }
        const loc = callPath.node.loc;
        if (!loc) {
          return;
        }
        const text = probeText(callPath.node);
        const id = computeProbeId({ file: opts.idFile, kind: 'log', text, line: loc.start.line });

        const argsArray = t.arrayExpression(
          callPath.node.arguments.map((arg) => {
            if (t.isSpreadElement(arg)) {
              return t.spreadElement(arg.argument);
            }
            if (t.isArgumentPlaceholder(arg)) {
              return null;
            }
            return arg as t.Expression;
          })
        );

        const replacement = t.callExpression(
          t.memberExpression(state.rlAgentId as t.Identifier, t.identifier('c')),
          [
            t.stringLiteral(level),
            t.stringLiteral(id),
            state.rlFileId as t.Identifier,
            t.numericLiteral(loc.start.line),
            t.numericLiteral(loc.start.column),
            argsArray
          ]
        );
        ourCalls.add(replacement);
        replacement.loc = loc;
        state.rlTouched = true;
        opts.probes.push({
          id,
          kind: 'log',
          level: level as LogLevel,
          file: opts.filename,
          line: loc.start.line,
          column: loc.start.column,
          text
        });
        // No `skip()`: Babel re-traverses the replacement, and our own call is
        // recognised by the `console` check above, so nested `console.log`
        // arguments keep getting instrumented while recursion stays impossible.
        callPath.replaceWith(replacement);
      },

      ExpressionStatement(stmtPath, state) {
        if (!opts.captureExpressions || !hasProbeComment(stmtPath.node)) {
          return;
        }
        const expression = stmtPath.get('expression');
        wrapExpression(expression as NodePath<t.Expression>, state, opts, ourCalls, probeText);
      },

      VariableDeclaration(declPath, state) {
        if (!opts.captureExpressions) {
          return;
        }
        if (!hasProbeComment(declPath.node)) {
          return;
        }
        for (const declarator of declPath.get('declarations')) {
          const init = declarator.get('init');
          if (init.node) {
            wrapExpression(init as NodePath<t.Expression>, state, opts, ourCalls, probeText);
          }
        }
      },

      ReturnStatement(retPath, state) {
        if (!opts.captureExpressions || !hasProbeComment(retPath.node)) {
          return;
        }
        const arg = retPath.get('argument');
        if (arg.node) {
          wrapExpression(arg as NodePath<t.Expression>, state, opts, ourCalls, probeText);
        }
      }
    }
  };
}

function wrapExpression(
  exprPath: NodePath<t.Expression>,
  state: PluginState,
  opts: { filename: string; idFile: string; probes: ProbeRecord[] },
  ourCalls: WeakSet<t.Node>,
  probeText: (node: t.Node) => string
): void {
  const node = exprPath.node;
  if (!node || ourCalls.has(node)) {
    return;
  }
  const loc = node.loc;
  if (!loc) {
    return;
  }
  const text = probeText(node);
  const id = computeProbeId({ file: opts.idFile, kind: 'expr', text, line: loc.start.line });
  const replacement = t.callExpression(t.memberExpression(state.rlAgentId as t.Identifier, t.identifier('e')), [
    t.stringLiteral(id),
    state.rlFileId as t.Identifier,
    t.numericLiteral(loc.start.line),
    t.numericLiteral(loc.start.column),
    t.stringLiteral(text.slice(0, 200)),
    node
  ]);
  ourCalls.add(replacement);
  replacement.loc = loc;
  state.rlTouched = true;
  opts.probes.push({
    id,
    kind: 'expr',
    file: opts.filename,
    line: loc.start.line,
    column: loc.start.column,
    text
  });
  exprPath.replaceWith(replacement);
}

/**
 * Instrument a single file. Returns the original code untouched (with
 * `skipped: true`) whenever the file must not be rewritten - excluded folder,
 * unsupported extension, already instrumented, or no probes found.
 */
export function instrument(code: string, options: TransformOptionsRL): TransformResult {
  const {
    filename,
    agentModule,
    captureConsole = true,
    captureExpressions = true,
    sourceMaps = true,
    stripTypes = false,
    projectRoot
  } = options;

  if (!shouldInstrument(filename)) {
    return { code, map: null, probes: [], skipped: true, reason: 'excluded-path' };
  }
  if (code.includes(INSTRUMENTED_MARKER)) {
    return { code, map: null, probes: [], skipped: true, reason: 'already-instrumented' };
  }
  if (!captureConsole && !captureExpressions) {
    return { code, map: null, probes: [], skipped: true, reason: 'capture-disabled' };
  }
  // Cheap pre-filter: if neither a console member access nor a probe comment
  // occurs anywhere in the text, parsing is pure overhead. This is a *skip*
  // heuristic only - it never rewrites anything, so false positives are free.
  if (!/console\s*\./.test(code) && !/\/\/\s*\?/.test(code)) {
    return { code, map: null, probes: [], skipped: true, reason: 'no-candidates' };
  }

  const moduleKind =
    options.moduleKind === undefined || options.moduleKind === 'auto'
      ? sniffModuleKind(code, filename)
      : options.moduleKind;
  const idFile = projectRoot ? path.relative(projectRoot, filename) || path.basename(filename) : filename;
  const probes: ProbeRecord[] = [];

  const plugins: TransformOptions['plugins'] = [
    createPlugin({
      captureConsole,
      captureExpressions,
      filename,
      idFile,
      agentModule,
      moduleKind,
      probes,
      source: code
    })
  ];
  if (stripTypes) {
    const ext = path.extname(filename).toLowerCase();
    plugins.push([
      require.resolve('@babel/plugin-transform-typescript'),
      { isTSX: ext === '.tsx', allowDeclareFields: true, onlyRemoveTypeImports: false }
    ]);
  }

  const result = transformSync(code, {
    filename,
    cwd: projectRoot ?? path.dirname(filename),
    root: projectRoot ?? path.dirname(filename),
    configFile: false,
    babelrc: false,
    browserslistConfigFile: false,
    ast: false,
    code: true,
    comments: true,
    compact: false,
    // Always parse as `unambiguous`: the prelude *form* is decided by
    // `moduleKind`, but a file can legitimately contain ESM syntax while being
    // compiled down to CJS (the require hook does exactly that), and parsing
    // such a file as a script is a hard syntax error.
    sourceType: 'unambiguous',
    sourceMaps,
    sourceFileName: filename,
    parserOpts: {
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      errorRecovery: false,
      plugins: parserPluginsFor(filename)
    },
    generatorOpts: {
      comments: true,
      retainLines: false,
      jsescOption: { minimal: true }
    },
    plugins
  });

  if (!result || typeof result.code !== 'string') {
    return { code, map: null, probes: [], skipped: true, reason: 'babel-returned-nothing' };
  }
  if (probes.length === 0) {
    return { code, map: null, probes: [], skipped: true, reason: 'no-probes' };
  }
  return { code: result.code, map: result.map ?? null, probes, skipped: false };
}
