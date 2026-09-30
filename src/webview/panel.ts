import * as vscode from 'vscode';
import { LOG_LEVELS, type ConsoleTablePayload, type LogLevel } from '../protocol';
import type { EventStore, StoredEvent } from '../runtime/store';
import { logger } from '../utils/logger';
import { eventText } from '../vscode/render';
import { toPlainText } from '../serialization/preview';
import { throttle } from '../utils/throttle';
import {
  parseWebviewMessage,
  type DetailMessage,
  type DetailMissingMessage,
  type HostMessage,
  type SnapshotMessage,
  type WireEvent
} from './messages';

export interface PanelHostActions {
  reveal(file: string, line: number): void;
  clear(): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setFilter(query: string, levels: LogLevel[] | undefined): void;
}

/**
 * The Runtime Explorer webview.
 *
 * It exists alongside the tree view rather than replacing it, because a
 * webview is the only way to get a real search box, live-updating virtual
 * list and a value pane in one surface - but a tree view is the only thing
 * that shows up in the activity bar without a click. Both read the same store.
 */
export class RuntimeExplorerPanel implements vscode.Disposable {
  static readonly viewType = 'runtimeLens.explorerPanel';
  private static current: RuntimeExplorerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private follow = true;
  private disposed = false;
  /** Wire form of events already sent; stored events are immutable, so it never goes stale. */
  private wireCache = new Map<number, WireEvent>();
  private readonly push = throttle(() => this.sendSnapshot(), 120);

  static show(
    extensionUri: vscode.Uri,
    store: EventStore,
    actions: PanelHostActions,
    column = vscode.ViewColumn.Beside
  ): RuntimeExplorerPanel {
    if (RuntimeExplorerPanel.current) {
      RuntimeExplorerPanel.current.panel.reveal(column);
      RuntimeExplorerPanel.current.push.flush();
      return RuntimeExplorerPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      RuntimeExplorerPanel.viewType,
      'Runtime Lens Explorer',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'out', 'src', 'webview', 'media')]
      }
    );
    RuntimeExplorerPanel.current = new RuntimeExplorerPanel(panel, extensionUri, store, actions);
    return RuntimeExplorerPanel.current;
  }

  /** Re-send state after something outside the panel changed it (e.g. Pause from the palette). */
  static refreshCurrent(): void {
    RuntimeExplorerPanel.current?.push.flush();
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly store: EventStore,
    private readonly actions: PanelHostActions
  ) {
    this.panel = panel;
    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message), null, this.disposables);

    const added = this.store.emitter.on('added', () => this.push());
    const cleared = this.store.emitter.on('cleared', () => this.push.flush());
    this.disposables.push({ dispose: () => added.dispose() }, { dispose: () => cleared.dispose() });
    this.sendSnapshot();
  }

  private onMessage(raw: unknown): void {
    const msg = parseWebviewMessage(raw);
    if (!msg) {
      // A message the contract doesn't allow is a bug on one side: say so.
      logger.warn(`ignored malformed webview message: ${safeType(raw)}`);
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.sendSnapshot();
        return;
      case 'filter': {
        const levels = msg.levels.filter((level): level is LogLevel => (LOG_LEVELS as readonly string[]).includes(level));
        this.actions.setFilter(msg.query, levels.length > 0 ? levels : undefined);
        this.push.flush();
        return;
      }
      case 'clear':
        this.actions.clear();
        return;
      case 'pause':
        this.actions.setPaused(msg.paused);
        this.push.flush();
        return;
      case 'follow':
        this.follow = msg.follow;
        return;
      case 'select':
        this.post(toDetail(this.store.find(msg.key)) ?? missing(msg.key));
        return;
      case 'reveal': {
        const stored = this.store.find(msg.key);
        if (stored) {
          this.actions.reveal(stored.loc.file, stored.loc.line);
        }
        return;
      }
      case 'copy': {
        const stored = this.store.find(msg.key);
        if (stored) {
          void vscode.env.clipboard.writeText(detailOf(stored));
          void vscode.window.showInformationMessage('Runtime Lens: value copied to clipboard.');
        }
        return;
      }
      case 'copy-text':
        void vscode.env.clipboard.writeText(msg.text);
        void vscode.window.showInformationMessage(`Runtime Lens: ${msg.label} copied to clipboard.`);
        return;
    }
  }

  private sendSnapshot(): void {
    const next = new Map<number, WireEvent>();
    for (const stored of this.store.list(400)) {
      next.set(stored.key, this.wireCache.get(stored.key) ?? toWire(stored));
    }
    this.wireCache = next;
    const message: SnapshotMessage = {
      type: 'snapshot',
      events: [...next.values()],
      follow: this.follow,
      paused: this.actions.isPaused(),
      filter: this.store.filter.query,
      stats: this.store.stats()
    };
    this.post(message);
  }

  /** Posting to a disposed webview throws; a throttled callback can race disposal. */
  private post(message: HostMessage): void {
    if (!this.disposed) {
      void this.panel.webview.postMessage(message);
    }
  }

  private render(): string {
    const webview = this.panel.webview;
    const nonce = createNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'src', 'webview', 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'src', 'webview', 'media', 'style.css')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>Runtime Lens Explorer</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.disposed = true;
    this.wireCache.clear();
    RuntimeExplorerPanel.current = undefined;
    this.push.cancel();
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/** The small, list-row form of an event. No values travel here: see `toDetail`. */
export function toWire(stored: StoredEvent): WireEvent {
  const file = stored.loc.file;
  const table: ConsoleTablePayload | undefined =
    stored.event.t === 'log' && stored.event.level === 'table' ? stored.event.table : undefined;

  return {
    key: stored.key,
    index: stored.index,
    kind: stored.event.t,
    level: stored.event.t === 'log' ? stored.event.level : undefined,
    text: eventText(stored.event, 300, 2),
    file,
    short: file.split('/').slice(-2).join('/'),
    line: stored.loc.line,
    count: stored.event.count,
    ts: stored.event.ts,
    remapped: stored.remapped,
    ...(table
      ? {
          table: {
            rows: table.rows.length,
            columns: table.columns.length,
            ...(table.truncated ? { truncated: true } : {}),
            ...(table.totalRows !== undefined ? { totalRows: table.totalRows } : {}),
            ...(table.totalColumns !== undefined ? { totalColumns: table.totalColumns } : {}),
            ...(table.indexLabel ? { indexLabel: table.indexLabel } : {})
          }
        }
      : {})
  };
}

/**
 * The heavy part of an event (its full text, or its table rows), built only
 * for the one event a person selected instead of for every event on every
 * snapshot.
 */
export function toDetail(stored: StoredEvent | undefined): DetailMessage | undefined {
  if (!stored) {
    return undefined;
  }
  const table = stored.event.t === 'log' && stored.event.level === 'table' ? stored.event.table : undefined;
  return table
    ? { type: 'detail', key: stored.key, detail: '', table }
    : { type: 'detail', key: stored.key, detail: detailOf(stored) };
}

function missing(key: number): DetailMissingMessage {
  return { type: 'detail-missing', key };
}

function safeType(raw: unknown): string {
  return typeof raw === 'object' && raw !== null && 'type' in raw ? String((raw as { type: unknown }).type) : typeof raw;
}

function detailOf(stored: StoredEvent): string {
  const { event } = stored;
  if (event.t === 'log') {
    return event.args.map((arg) => toPlainText(arg)).join('\n');
  }
  if (event.t === 'expr') {
    return `${event.expr} =\n${toPlainText(event.value)}`;
  }
  return event.stack ?? event.message;
}

export function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}
