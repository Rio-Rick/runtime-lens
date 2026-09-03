import * as vscode from 'vscode';

export type RuntimeLensState = 'active' | 'paused' | 'disconnected' | 'error' | 'disabled';

interface StateStyle {
  icon: string;
  label: string;
  background?: string;
}

const STYLES: Record<RuntimeLensState, StateStyle> = {
  active: { icon: '$(telescope)', label: 'Active' },
  paused: { icon: '$(debug-pause)', label: 'Paused', background: 'statusBarItem.warningBackground' },
  disconnected: { icon: '$(debug-disconnect)', label: 'Disconnected' },
  error: { icon: '$(error)', label: 'Error', background: 'statusBarItem.errorBackground' },
  disabled: { icon: '$(circle-slash)', label: 'Off' }
};

/**
 * Status bar entry. It is the single place a user looks to answer "is Runtime
 * Lens actually receiving anything?", so it always shows state + session count
 * + live event total, and its tooltip carries the exact command to run next.
 */
export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private state: RuntimeLensState = 'disconnected';
  private detail = '';
  private eventCount = 0;
  private sessions = 0;
  private lastError: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem('runtimeLens.status', vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'Runtime Lens';
    this.item.command = 'runtimeLens.showRuntimeExplorer';
    this.render();
    this.item.show();
  }

  setState(state: RuntimeLensState, detail = ''): void {
    this.state = state;
    this.detail = detail;
    if (state !== 'error') {
      this.lastError = undefined;
    }
    this.render();
  }

  setError(message: string): void {
    this.lastError = message;
    this.state = 'error';
    this.render();
  }

  setCounters(sessions: number, eventCount: number): void {
    this.sessions = sessions;
    this.eventCount = eventCount;
    this.render();
  }

  get currentState(): RuntimeLensState {
    return this.state;
  }

  /** Exposed for tests: the exact rendered text. */
  get text(): string {
    return this.item.text;
  }

  private render(): void {
    const style = STYLES[this.state];
    const counters = this.state === 'active' || this.state === 'paused' ? ` ${this.eventCount}` : '';
    this.item.text = `${style.icon} Runtime Lens: ${style.label}${counters}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**Runtime Lens** — ${style.label}\n\n`);
    if (this.detail) {
      tooltip.appendMarkdown(`${this.detail}\n\n`);
    }
    if (this.lastError) {
      tooltip.appendMarkdown(`\`${this.lastError}\`\n\n`);
    }
    tooltip.appendMarkdown(`Sessions: ${this.sessions} · Events: ${this.eventCount}\n\n`);
    tooltip.appendMarkdown(
      this.state === 'paused'
        ? 'Run **Runtime Lens: Resume Capture** to continue.'
        : this.state === 'disconnected'
          ? 'Start your dev process with the printed command, or run **Runtime Lens: Start**.'
          : 'Click to open the Runtime Explorer.'
    );
    this.item.tooltip = tooltip;
    this.item.backgroundColor = style.background ? new vscode.ThemeColor(style.background) : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
