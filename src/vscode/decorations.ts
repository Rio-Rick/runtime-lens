import * as vscode from 'vscode';
import type { EventStore, StoredEvent } from '../runtime/store';
import { throttle } from '../utils/throttle';
import { normalizePath } from '../utils/paths';
import { hoverMarkdown, inlineText, type RenderConfig } from './render';

const LANGUAGES = new Set(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']);

/**
 * Inline value decorations.
 *
 * Performance notes (this is the hot path of the whole extension):
 *  - three decoration *types* total (value / warn / error), because VS Code
 *    documents that per-decoration `renderOptions` are expensive;
 *  - a trailing-edge throttle at 80 ms, so a 10k-events-per-second loop still
 *    repaints at most ~12 times a second;
 *  - only visible editors are repainted, and only the latest event per line is
 *    considered, which the store already indexes for us.
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

  stats(): { paints: number; lastPaint: number } {
    return { paints: this.paints, lastPaint: this.lastPaint };
  }

  /** Repaint immediately (used by commands and tests). */
  refresh(): void {
    this.schedule.flush();
  }

  private clearAll(): void {
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
    for (const editor of vscode.window.visibleTextEditors) {
      this.paintEditor(editor);
    }
  }

  private paintEditor(editor: vscode.TextEditor): void {
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

    for (const stored of events) {
      const option = this.toDecoration(editor.document, stored);
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

  private toDecoration(document: vscode.TextDocument, stored: StoredEvent): vscode.DecorationOptions | undefined {
    const lineIndex = stored.loc.line - 1;
    if (lineIndex < 0 || lineIndex >= document.lineCount) {
      return undefined;
    }
    const line = document.lineAt(lineIndex);
    const hover = new vscode.MarkdownString(hoverMarkdown(stored, this.renderConfig));
    hover.isTrusted = false;
    hover.supportThemeIcons = true;
    return {
      range: new vscode.Range(line.range.end, line.range.end),
      hoverMessage: hover,
      renderOptions: { after: { contentText: inlineText(stored.event, this.renderConfig) } }
    };
  }

  dispose(): void {
    this.schedule.cancel();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
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
