import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SerializedValue } from '../protocol';
import type { EventStore, StoredEvent } from '../runtime/store';
import type { SessionInfo } from '../runtime/server';
import { preview } from '../serialization/preview';
import { throttle } from '../utils/throttle';
import { eventText, hoverMarkdown, levelIcon, type RenderConfig } from './render';

export type ExplorerNode =
  | { kind: 'session'; session: SessionInfo }
  | { kind: 'event'; stored: StoredEvent }
  | { kind: 'value'; parentKey: number; label: string; value: SerializedValue; pathText: string }
  | { kind: 'message'; label: string; detail?: string; icon?: string };

/**
 * The "Runtime Lens" tree view.
 *
 * Layout is session -> event -> value, which mirrors how people debug: they
 * first ask "which process produced this?", then "what happened?", then "what
 * is inside this object?". Filtering applies at the event level so sessions
 * never disappear while you are typing a query.
 */
export class RuntimeExplorerProvider implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<ExplorerNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private sessions: SessionInfo[] = [];
  private paused = false;
  private follow = true;
  private view: vscode.TreeView<ExplorerNode> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  // Throttled: only for the high-frequency path (a hot loop flooding `added`
  // events). Every other caller wants an immediate, guaranteed refresh, which
  // is what refreshNow() below provides - throttle().flush() is NOT that; it
  // only re-runs a call that's already queued, and is a no-op otherwise.
  private readonly refresh = throttle(() => this.changeEmitter.fire(undefined), 150);

  constructor(private readonly store: EventStore, private readonly getConfig: () => RenderConfig) {
    const added = this.store.emitter.on('added', ({ events }) => {
      if (!this.paused) {
        this.refresh();
        if (this.follow) {
          this.revealLatest(events[events.length - 1]);
        }
      }
    });
    const cleared = this.store.emitter.on('cleared', () => this.refreshNow());
    const filtered = this.store.emitter.on('filter-changed', () => this.refreshNow());
    this.disposables.push(
      { dispose: () => added.dispose() },
      { dispose: () => cleared.dispose() },
      { dispose: () => filtered.dispose() }
    );
  }

  attachView(view: vscode.TreeView<ExplorerNode>): void {
    this.view = view;
    this.updateDescription();
  }

  setSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    this.refreshNow();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.updateDescription();
    this.refreshNow();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  toggleFollow(): boolean {
    this.follow = !this.follow;
    this.updateDescription();
    if (this.follow) {
      // Jump to the latest event right away rather than waiting for the next
      // one to arrive, so switching follow on feels immediate.
      this.revealLatest(this.store.list(1)[0]);
    }
    return this.follow;
  }

  /**
   * Force an immediate tree refresh, bypassing the throttle entirely.
   * Use this for one-off, user-initiated changes (filter, pause, session
   * list, clear) where staleness is not acceptable. Reserve the throttled
   * `refresh()` for the high-frequency `added` event stream.
   */
  private refreshNow(): void {
    this.refresh.cancel();
    this.changeEmitter.fire(undefined);
  }

  get isFollowing(): boolean {
    return this.follow;
  }

  private updateDescription(): void {
    if (!this.view) {
      return;
    }
    const filter = this.store.filter.query;
    const bits: string[] = [];
    if (this.paused) {
      bits.push('paused');
    }
    if (this.follow) {
      bits.push('following');
    }
    if (filter) {
      bits.push(`"${filter}"`);
    }
    this.view.description = bits.join(' · ');
  }

  private revealLatest(stored: StoredEvent | undefined): void {
    if (!stored || !this.view || !this.view.visible) {
      return;
    }
    // Reveal is best-effort: the tree may not have materialised the node yet.
    void this.view.reveal({ kind: 'event', stored }, { select: false, focus: false }).then(undefined, () => undefined);
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    switch (node.kind) {
      case 'session': {
        const item = new vscode.TreeItem(node.session.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = `session:${node.session.sessionId}`;
        item.description = `${node.session.runtime} · ${node.session.eventCount} events${
          node.session.droppedByAgent > 0 ? ` · ${node.session.droppedByAgent} dropped` : ''
        }`;
        item.iconPath = new vscode.ThemeIcon(node.session.runtime === 'browser' ? 'browser' : 'server-process');
        item.contextValue = 'runtimeLensSession';
        item.tooltip = new vscode.MarkdownString(
          [
            `**${node.session.label}**`,
            '',
            `- runtime: \`${node.session.runtime}\``,
            `- transport: \`${node.session.transport}\``,
            node.session.pid ? `- pid: \`${node.session.pid}\`` : '',
            node.session.cwd ? `- cwd: \`${node.session.cwd}\`` : '',
            `- connected: ${new Date(node.session.connectedAt).toLocaleTimeString()}`
          ]
            .filter(Boolean)
            .join('\n')
        );
        return item;
      }
      case 'event': {
        const { stored } = node;
        const label = eventText(stored.event, 140, 1);
        const item = new vscode.TreeItem(label || '(empty)', hasChildren(stored) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = `event:${stored.key}`;
        item.description = `${path.basename(stored.loc.file)}:${stored.loc.line}${
          stored.event.count > 1 ? ` × ${stored.event.count}` : ''
        }`;
        item.iconPath = new vscode.ThemeIcon(levelIcon(stored.event));
        item.contextValue = 'runtimeLensEvent';
        item.tooltip = new vscode.MarkdownString(hoverMarkdown(stored, this.getConfig()));
        item.command = {
          command: 'runtimeLens.revealEvent',
          title: 'Go to source',
          arguments: [node]
        };
        return item;
      }
      case 'value': {
        const expandable = isContainer(node.value);
        const item = new vscode.TreeItem(
          `${node.label}: ${preview(node.value, { maxLength: 120, depth: 1 })}`,
          expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        item.id = `value:${node.parentKey}:${node.pathText}`;
        item.iconPath = new vscode.ThemeIcon(iconForValue(node.value));
        item.contextValue = 'runtimeLensValue';
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.detail;
        item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
        item.contextValue = 'runtimeLensMessage';
        return item;
      }
      default:
        return new vscode.TreeItem('unknown');
    }
  }

  getChildren(node?: ExplorerNode): ExplorerNode[] {
    if (!node) {
      if (this.sessions.length === 0) {
        return [
          {
            kind: 'message',
            label: 'No instrumented process connected',
            detail: 'run “Runtime Lens: Start”',
            icon: 'debug-disconnect'
          }
        ];
      }
      return this.sessions.map((session) => ({ kind: 'session', session }));
    }
    if (node.kind === 'session') {
      const events = this.store.list(500).filter((stored) => stored.sessionId === node.session.sessionId);
      if (events.length === 0) {
        return [{ kind: 'message', label: 'No events match the current filter', icon: 'search-stop' }];
      }
      return events.map((stored) => ({ kind: 'event', stored }));
    }
    if (node.kind === 'event') {
      return childrenOfEvent(node.stored);
    }
    if (node.kind === 'value') {
      return childrenOfValue(node.value, node.parentKey, node.pathText);
    }
    return [];
  }

  getParent(node: ExplorerNode): ExplorerNode | undefined {
    if (node.kind === 'event') {
      const session = this.sessions.find((s) => s.sessionId === node.stored.sessionId);
      return session ? { kind: 'session', session } : undefined;
    }
    return undefined;
  }

  dispose(): void {
    this.refresh.cancel();
    this.changeEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function hasChildren(stored: StoredEvent): boolean {
  return childrenOfEvent(stored).length > 0;
}

function childrenOfEvent(stored: StoredEvent): ExplorerNode[] {
  const { event } = stored;
  if (event.t === 'log') {
    return event.args.map((arg, index) => ({
      kind: 'value' as const,
      parentKey: stored.key,
      label: event.exprs?.[index] ?? `arg ${index}`,
      value: arg,
      pathText: `arg${index}`
    }));
  }
  if (event.t === 'expr') {
    return [{ kind: 'value', parentKey: stored.key, label: event.expr, value: event.value, pathText: 'value' }];
  }
  if (event.stack) {
    return event.stack
      .split('\n')
      .slice(0, 12)
      .map((frame, index) => ({ kind: 'message' as const, label: frame.trim(), icon: 'debug-stackframe', detail: `#${index}` }));
  }
  return [];
}

function childrenOfValue(value: SerializedValue, parentKey: number, basePath: string): ExplorerNode[] {
  switch (value.k) {
    case 'object':
      return value.entries.map(([key, child]) => ({
        kind: 'value' as const,
        parentKey,
        label: key,
        value: child,
        pathText: `${basePath}.${key}`
      }));
    case 'array':
    case 'set':
      return value.entries.map((child, index) => ({
        kind: 'value' as const,
        parentKey,
        label: String(index),
        value: child,
        pathText: `${basePath}[${index}]`
      }));
    case 'map':
      return value.entries.map(([key, child], index) => ({
        kind: 'value' as const,
        parentKey,
        label: preview(key, { maxLength: 40 }),
        value: child,
        pathText: `${basePath}.entry${index}`
      }));
    case 'error':
      return Object.entries(value.props ?? {}).map(([key, child]) => ({
        kind: 'value' as const,
        parentKey,
        label: key,
        value: child,
        pathText: `${basePath}.${key}`
      }));
    default:
      return [];
  }
}

function isContainer(value: SerializedValue): boolean {
  return (
    value.k === 'object' ||
    value.k === 'array' ||
    value.k === 'map' ||
    value.k === 'set' ||
    (value.k === 'error' && value.props !== undefined)
  );
}

function iconForValue(value: SerializedValue): string {
  switch (value.k) {
    case 'string':
      return 'symbol-string';
    case 'number':
    case 'bigint':
      return 'symbol-number';
    case 'boolean':
      return 'symbol-boolean';
    case 'array':
    case 'set':
      return 'symbol-array';
    case 'object':
    case 'map':
      return 'symbol-object';
    case 'function':
      return 'symbol-method';
    case 'error':
      return 'error';
    case 'date':
      return 'calendar';
    case 'circular':
      return 'sync';
    default:
      return 'symbol-misc';
  }
}
