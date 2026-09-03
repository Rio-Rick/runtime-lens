import * as vscode from 'vscode';
import type { LogLevel } from '../protocol';
import type { EventStore, StoredEvent } from '../runtime/store';
import { eventText } from '../vscode/render';
import { toPlainText } from '../serialization/preview';
import { throttle } from '../utils/throttle';

export interface PanelHostActions {
  reveal(file: string, line: number): void;
  clear(): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setFilter(query: string, levels: LogLevel[] | undefined): void;
}

interface WireEvent {
  key: number;
  kind: string;
  level?: string;
  text: string;
  detail: string;
  file: string;
  short: string;
  line: number;
  count: number;
  ts: number;
  remapped: boolean;
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

  private onMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) {
      return;
    }
    const msg = message as { type?: string; query?: string; levels?: string[]; key?: number; follow?: boolean; paused?: boolean };
    switch (msg.type) {
      case 'ready':
        this.sendSnapshot();
        return;
      case 'filter':
        this.actions.setFilter(String(msg.query ?? ''), (msg.levels as LogLevel[] | undefined)?.length ? (msg.levels as LogLevel[]) : undefined);
        this.push.flush();
        return;
      case 'clear':
        this.actions.clear();
        return;
      case 'pause':
        this.actions.setPaused(msg.paused === true);
        this.push.flush();
        return;
      case 'follow':
        this.follow = msg.follow === true;
        return;
      case 'reveal': {
        const stored = this.find(msg.key);
        if (stored) {
          this.actions.reveal(stored.loc.file, stored.loc.line);
        }
        return;
      }
      case 'copy': {
        const stored = this.find(msg.key);
        if (stored) {
          void vscode.env.clipboard.writeText(detailOf(stored));
          void vscode.window.showInformationMessage('Runtime Lens: value copied to clipboard.');
        }
        return;
      }
      default:
        return;
    }
  }

  private find(key: number | undefined): StoredEvent | undefined {
    if (key === undefined) {
      return undefined;
    }
    return this.store.list(2000).find((item) => item.key === key);
  }

  private sendSnapshot(): void {
    const events: WireEvent[] = this.store.list(400).map(toWire);
    void this.panel.webview.postMessage({
      type: 'snapshot',
      events,
      follow: this.follow,
      paused: this.actions.isPaused(),
      filter: this.store.filter.query,
      stats: this.store.stats()
    });
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
  <header class="toolbar">
    <input id="search" type="search" placeholder="Search values, files…" autocomplete="off" />
    <div class="levels" id="levels">
      <label><input type="checkbox" value="log" checked /> log</label>
      <label><input type="checkbox" value="info" checked /> info</label>
      <label><input type="checkbox" value="warn" checked /> warn</label>
      <label><input type="checkbox" value="error" checked /> error</label>
      <label><input type="checkbox" value="debug" checked /> debug</label>
      <label><input type="checkbox" value="table" checked /> table</label>
    </div>
    <div class="actions">
      <button id="pause" title="Pause capture">Pause</button>
      <button id="follow" class="on" title="Follow latest">Follow</button>
      <button id="clear" title="Clear logs">Clear</button>
    </div>
  </header>
  <main>
    <ul id="list" class="list"></ul>
    <section id="detail" class="detail"><p class="hint">Select an event to inspect its value.</p></section>
  </main>
  <footer id="status" class="status"></footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    RuntimeExplorerPanel.current = undefined;
    this.push.cancel();
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

export function toWire(stored: StoredEvent): WireEvent {
  const file = stored.loc.file;
  return {
    key: stored.key,
    kind: stored.event.t,
    level: stored.event.t === 'log' ? stored.event.level : undefined,
    text: eventText(stored.event, 300, 2),
    detail: detailOf(stored),
    file,
    short: file.split('/').slice(-2).join('/'),
    line: stored.loc.line,
    count: stored.event.count,
    ts: stored.event.ts,
    remapped: stored.remapped
  };
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
