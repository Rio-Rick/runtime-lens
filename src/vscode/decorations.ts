import * as vscode from 'vscode';
import type { EventStore, StoredEvent } from '../runtime/store';
import { throttle } from '../utils/throttle';
import { normalizePath } from '../utils/paths';
import { SHOW_PROBE_HISTORY_COMMAND, hoverExtras, hoverMarkdown, inlineExtras, inlineText, type RenderConfig } from './render';

const LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

/** Lines painted above and below the viewport, so short scrolls never show a gap. */
const VISIBLE_MARGIN = 100;

interface CachedOption {
  /** Decorations are anchored to the end of a line, so an edit invalidates them. */
  version: number;
  option: vscode.DecorationOptions;
}

/**
 * Inline value decorations.
 *
 * Performance notes (this is the hot path of the whole extension):
 *  - three decoration *types* total (value / warn / error), because VS Code
 *    documents that per-decoration `renderOptions` are expensive;
 *  - a trailing-edge throttle at 80 ms, so a 10k-events-per-second loop still
 *    repaints at most ~12 times a second;
 *  - only visible editors are repainted, and only the latest event per line is
 *    considered, which the store already indexes for us;
 *  - only lines in (or near) the viewport are decorated, so a file with
 *    thousands of probed lines costs the same as one with a screenful;
 *  - each line's decoration (inline text + hover, which now also carries
 *    history and stats) is cached by event key and rebuilt only when that
 *    line's latest event changes, the document is edited or the render
 *    settings change - a hot loop on one line rebuilds one decoration per
 *    repaint, not every line in the file.
 */
export class DecorationManager implements vscode.Disposable {
  private readonly valueType: vscode.TextEditorDecorationType;
  private readonly warnType: vscode.TextEditorDecorationType;
  private readonly errorType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private enabled = true;
  private renderConfig: RenderConfig;
  private lastPaint = 0;
  private paints = 0;
  private lastPaintMs = 0;
  private maxPaintMs = 0;
  private cache = new Map<number, CachedOption>();

  private readonly schedule = throttle(() => this.paintAll(), 80);

  constructor(private readonly store: EventStore, renderConfig: RenderConfig) {
    this.renderConfig = renderConfig;
    const common: vscode.DecorationRenderOptions = {
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      after: { margin: '0 0 0 1.5rem', fontStyle: 'italic' }
    };
    this.valueType = vscode.window.createTextEditorDecorationType({
      ...common,
      after: { ...common.after, color: new vscode.ThemeColor('editorCodeLens.foreground') }
    });
    this.warnType = vscode.window.createTextEditorDecorationType({
      ...common,
      after: { ...common.after, color: new vscode.ThemeColor('editorWarning.foreground') }
    });
    this.errorType = vscode.window.createTextEditorDecorationType({
      ...common,
      after: { ...common.after, color: new vscode.ThemeColor('editorError.foreground') }
    });

    this.disposables.push(
      this.valueType,
      this.warnType,
      this.errorType,
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.window.onDidChangeTextEditorVisibleRanges(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (LANGUAGES.has(e.document.languageId)) {
          this.schedule();
        }
      })
    );

    const added = this.store.emitter.on('added', () => this.schedule());
    const cleared = this.store.emitter.on('cleared', () => this.clearAll());
    this.disposables.push({ dispose: () => added.dispose() }, { dispose: () => cleared.dispose() });
  }

  setRenderConfig(config: RenderConfig): void {
    this.renderConfig = config;
    this.cache.clear();
    this.schedule();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.schedule();
    } else {
      this.clearAll();
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  stats(): { paints: number; lastPaint: number; lastPaintMs: number; maxPaintMs: number } {
    return { paints: this.paints, lastPaint: this.lastPaint, lastPaintMs: this.lastPaintMs, maxPaintMs: this.maxPaintMs };
  }

  /** Repaint immediately (used by commands and tests). */
  refresh(): void {
    this.schedule.flush();
  }

  private clearAll(): void {
    this.cache.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.valueType, []);
      editor.setDecorations(this.warnType, []);
      editor.setDecorations(this.errorType, []);
    }
  }

  private paintAll(): void {
    if (!this.enabled) {
      return;
    }
    this.paints++;
    this.lastPaint = Date.now();
    const started = performance.now();
    // Entries not used in this pass (superseded events, scrolled-away lines)
    // are dropped by swapping maps, so the cache can never outgrow the screen.
    const next = new Map<number, CachedOption>();
    for (const editor of vscode.window.visibleTextEditors) {
      this.paintEditor(editor, next);
    }
    this.cache = next;
    this.lastPaintMs = performance.now() - started;
    this.maxPaintMs = Math.max(this.maxPaintMs, this.lastPaintMs);
  }

  private paintEditor(editor: vscode.TextEditor, next: Map<number, CachedOption>): void {
    if (!LANGUAGES.has(editor.document.languageId)) {
      return;
    }
    const file = normalizePath(editor.document.uri.fsPath);
    const events = this.store.forFile(file);
    if (events.length === 0) {
      editor.setDecorations(this.valueType, []);
      editor.setDecorations(this.warnType, []);
      editor.setDecorations(this.errorType, []);
      return;
    }
    const values: vscode.DecorationOptions[] = [];
    const warns: vscode.DecorationOptions[] = [];
    const errors: vscode.DecorationOptions[] = [];

    const { first, last } = visibleWindow(editor);
    for (const stored of events) {
      const lineIndex = stored.loc.line - 1;
      if (lineIndex > last) {
        break; // forFile() is sorted by line, so nothing below is visible either
      }
      if (lineIndex < first) {
        continue;
      }
      const option = this.optionFor(editor.document, stored, next);
      if (!option) {
        continue;
      }
      const severity = severityOf(stored);
      if (severity === 'error') {
        errors.push(option);
      } else if (severity === 'warn') {
        warns.push(option);
      } else {
        values.push(option);
      }
    }
    editor.setDecorations(this.valueType, values);
    editor.setDecorations(this.warnType, warns);
    editor.setDecorations(this.errorType, errors);
  }

  private optionFor(
    document: vscode.TextDocument,
    stored: StoredEvent,
    next: Map<number, CachedOption>
  ): vscode.DecorationOptions | undefined {
    const hit = this.cache.get(stored.key);
    if (hit && hit.version === document.version) {
      next.set(stored.key, hit);
      return hit.option;
    }
    const option = this.toDecoration(document, stored);
    if (option) {
      next.set(stored.key, { version: document.version, option });
    }
    return option;
  }

  private toDecoration(document: vscode.TextDocument, stored: StoredEvent): vscode.DecorationOptions | undefined {
    const lineIndex = stored.loc.line - 1;
    if (lineIndex < 0 || lineIndex >= document.lineCount) {
      return undefined;
    }
    const line = document.lineAt(lineIndex);
    const config = this.renderConfig;
    const hover = new vscode.MarkdownString(hoverMarkdown(stored, config, hoverExtras(this.store, stored, config)));
    // Only the one command behind the "all runs" link may be triggered from this hover.
    hover.isTrusted = { enabledCommands: [SHOW_PROBE_HISTORY_COMMAND] };
    hover.supportThemeIcons = true;
    return {
      range: new vscode.Range(line.range.end, line.range.end),
      hoverMessage: hover,
      renderOptions: {
        after: { contentText: inlineText(stored.event, config, inlineExtras(this.store, stored, config)) }
      }
    };
  }

  dispose(): void {
    this.schedule.cancel();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** 0-based line window to decorate: the viewport plus a margin (everything if the editor reports none). */
function visibleWindow(editor: vscode.TextEditor): { first: number; last: number } {
  const ranges = editor.visibleRanges;
  if (ranges.length === 0) {
    return { first: 0, last: Number.MAX_SAFE_INTEGER };
  }
  let first = Number.MAX_SAFE_INTEGER;
  let last = -1;
  for (const range of ranges) {
    first = Math.min(first, range.start.line);
    last = Math.max(last, range.end.line);
  }
  return { first: first - VISIBLE_MARGIN, last: last + VISIBLE_MARGIN };
}

export function severityOf(stored: StoredEvent): 'error' | 'warn' | 'value' {
  if (stored.event.t === 'error') {
    return 'error';
  }
  if (stored.event.t === 'log') {
    if (stored.event.level === 'error') {
      return 'error';
    }
    if (stored.event.level === 'warn') {
      return 'warn';
    }
  }
  return 'value';
}
