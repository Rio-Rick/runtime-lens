import * as vscode from 'vscode';
import type { EventStore } from '../runtime/store';
import { normalizePath } from '../utils/paths';
import { hoverMarkdown, type RenderConfig } from './render';

export const HOVER_LANGUAGES: vscode.DocumentSelector = [
  { language: 'javascript', scheme: 'file' },
  { language: 'javascriptreact', scheme: 'file' },
  { language: 'typescript', scheme: 'file' },
  { language: 'typescriptreact', scheme: 'file' }
];

/**
 * Hover-based object inspector.
 *
 * Nested Markdown lists give a genuine expandable tree inside the hover
 * without paying for a webview, and the hover also exposes a command link
 * that opens the full value in the Runtime Explorer panel.
 */
export class RuntimeHoverProvider implements vscode.HoverProvider {
  constructor(private readonly store: EventStore, private getConfig: () => RenderConfig) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const stored = this.store.latestAt(normalizePath(document.uri.fsPath), position.line + 1);
    if (!stored) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString(hoverMarkdown(stored, this.getConfig()));
    markdown.supportThemeIcons = true;
    markdown.isTrusted = { enabledCommands: ['runtimeLens.showRuntimeExplorer'] };
    markdown.appendMarkdown(
      `\n\n[$(telescope) Open in Runtime Explorer](command:runtimeLens.showRuntimeExplorer)`
    );
    const line = document.lineAt(position.line);
    return new vscode.Hover(markdown, line.range);
  }
}
