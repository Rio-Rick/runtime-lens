import * as path from 'node:path';
import * as vscode from 'vscode';
import { PROTOCOL_VERSION, type LogLevel, type RuntimeEvent } from '../protocol';
import { detectProject, type ProjectProfile } from '../framework/detect';
import { selectStrategy, type IntegrationStrategy } from '../framework/strategy';
import { SourceMapResolver } from '../instrumentation/source-maps';
import { RuntimeServer, type SessionInfo } from '../runtime/server';
import { EventStore, type StoredEvent } from '../runtime/store';
import { logger } from '../utils/logger';
import { RuntimeExplorerPanel } from '../webview/panel';
import { readConfig, updateConfig, type RuntimeLensConfig } from './config';
import { DecorationManager } from './decorations';
import { RuntimeDiagnostics } from './diagnostics';
import { RuntimeExplorerProvider, type ExplorerNode } from './explorer';
import { HOVER_LANGUAGES, RuntimeHoverProvider } from './hover';
import { eventText, type RenderConfig } from './render';
import { StatusBar } from './status-bar';

/**
 * The single owner of all extension state.
 *
 * Everything flows one way: server -> source-map remap -> store -> (decorations,
 * tree, webview, diagnostics, status bar). No view ever mutates another view;
 * they all re-read the store. That is what keeps pause/resume, filtering and
 * clearing consistent across four different surfaces.
 */
export class RuntimeLensController implements vscode.Disposable {
  readonly store: EventStore;
  readonly statusBar: StatusBar;
  readonly explorer: RuntimeExplorerProvider;
  readonly diagnostics: RuntimeDiagnostics;
  readonly decorations: DecorationManager;
  readonly output: vscode.OutputChannel;

  private server: RuntimeServer | undefined;
  private readonly sourceMaps = new SourceMapResolver();
  private readonly disposables: vscode.Disposable[] = [];
  private config: RuntimeLensConfig;
  private paused = false;
  private profile: ProjectProfile | undefined;
  private strategy: IntegrationStrategy | undefined;
  private treeView: vscode.TreeView<ExplorerNode> | undefined;
  private startedAt = 0;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.config = readConfig();
    this.output = vscode.window.createOutputChannel('Runtime Lens');
    logger.addSink((line) => this.output.appendLine(line));

    this.store = new EventStore(this.config.maxHistory, (event: RuntimeEvent) => eventText(event, 400, 2));
    this.statusBar = new StatusBar();
    this.diagnostics = new RuntimeDiagnostics();
    this.decorations = new DecorationManager(this.store, this.renderConfig());
    this.explorer = new RuntimeExplorerProvider(this.store, () => this.renderConfig());

    this.treeView = vscode.window.createTreeView<ExplorerNode>('runtimeLens.explorer', {
      treeDataProvider: this.explorer,
      showCollapseAll: true
    });
    this.explorer.attachView(this.treeView);

    this.disposables.push(
      this.output,
      this.statusBar,
      this.diagnostics,
      this.decorations,
      this.explorer,
      this.treeView,
      vscode.languages.registerHoverProvider(HOVER_LANGUAGES, new RuntimeHoverProvider(this.store, () => this.renderConfig())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('runtimeLens')) {
          void this.onConfigChanged();
        }
      })
    );

    const added = this.store.emitter.on('added', ({ events }) => {
      this.diagnostics.report(events);
      this.statusBar.setCounters(this.server?.listSessions().length ?? 0, this.store.stats().totalAdded);
    });
    this.disposables.push({ dispose: () => added.dispose() });

    void vscode.commands.executeCommand('setContext', 'runtimeLens.paused', false);
    this.statusBar.setState(this.config.enabled ? 'disconnected' : 'disabled');
  }

  // ------------------------------------------------------------------ config

  renderConfig(): RenderConfig {
    return {
      maxInlineLength: this.config.maxInlineLength,
      showTimestamp: this.config.showTimestamp,
      showExecutionCount: this.config.showExecutionCount,
      objectDepth: this.config.objectDepth
    };
  }

  private async onConfigChanged(): Promise<void> {
    const previous = this.config;
    this.config = readConfig();
    this.store.setMaxHistory(this.config.maxHistory);
    this.decorations.setRenderConfig(this.renderConfig());
    this.decorations.setEnabled(this.config.enabled && this.config.inlineValues);
    this.server?.broadcastConfig();
    if (previous.enabled && !this.config.enabled) {
      await this.stop();
      this.statusBar.setState('disabled');
    } else if (!previous.enabled && this.config.enabled) {
      await this.start();
    } else if (previous.port !== this.config.port && this.server?.isRunning) {
      await this.restart();
    }
    logger.debug(`configuration reloaded: ${JSON.stringify(this.config)}`);
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (!this.config.enabled) {
      void vscode.window.showWarningMessage('Runtime Lens is disabled. Set `runtimeLens.enabled` to true first.');
      return;
    }
    if (this.server?.isRunning) {
      void vscode.window.showInformationMessage(`Runtime Lens already listening on port ${this.server.port}.`);
      return;
    }
    const server = new RuntimeServer({
      preferredPort: this.config.port,
      maxPayloadBytes: this.config.maxPayloadBytes,
      getAgentConfig: () => ({
        captureConsole: this.config.captureConsole,
        captureExpressions: this.config.captureExpressions,
        paused: this.paused,
        objectDepth: this.config.objectDepth
      })
    });
    this.server = server;
    this.wireServer(server);

    try {
      const { port, token } = await server.start();
      this.startedAt = Date.now();
      logger.info(`runtime server listening on 127.0.0.1:${port} (protocol ${PROTOCOL_VERSION})`);
      this.applyStrategy(port, token);
      this.statusBar.setState('disconnected', `Listening on 127.0.0.1:${port}. Waiting for an instrumented process.`);
      this.decorations.setEnabled(this.config.inlineValues);
    } catch (err) {
      logger.error('failed to start runtime server', err);
      this.statusBar.setError((err as Error).message);
      void vscode.window.showErrorMessage(`Runtime Lens could not start: ${(err as Error).message}`);
    }
  }

  private wireServer(server: RuntimeServer): void {
    server.emitter.on('events', ({ sessionId, events, dropped }) => {
      if (this.paused) {
        return;
      }
      const entries = events.map((event) => {
        const resolved = this.sourceMaps.resolve(event.loc);
        return { event, sessionId, loc: { ...resolved }, remapped: resolved.remapped };
      });
      this.store.add(entries);
      if (dropped > 0) {
        logger.warn(`agent ${sessionId} dropped ${dropped} events (bounded buffer)`);
      }
      this.statusBar.setState('active', `${server.listSessions().length} session(s) connected.`);
      this.explorer.setSessions(server.listSessions());
    });
    server.emitter.on('session-open', (session: SessionInfo) => {
      logger.info(`session opened: ${session.label} (${session.runtime}, ${session.transport})`);
      this.explorer.setSessions(server.listSessions());
      this.statusBar.setState(this.paused ? 'paused' : 'active', `${session.label} connected.`);
    });
    server.emitter.on('session-close', ({ sessionId, reason }) => {
      logger.info(`session closed: ${sessionId} (${reason ?? 'unknown'})`);
      this.explorer.setSessions(server.listSessions());
      if (server.listSessions().length === 0) {
        this.statusBar.setState('disconnected', 'No instrumented process connected.');
      }
    });
    server.emitter.on('protocol-error', ({ code, message }) => {
      logger.warn(`protocol error [${code}]: ${message}`);
      if (code === 'bad-version') {
        this.statusBar.setError(message);
      }
    });
    server.emitter.on('error', ({ error }) => {
      logger.error('server error', error);
      this.statusBar.setError(error.message);
    });
  }

  private applyStrategy(port: number, token: string): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      logger.warn('no workspace folder open; skipping framework detection');
      return;
    }
    this.profile = detectProject(root);
    this.strategy = selectStrategy(this.profile, {
      port,
      token,
      extensionOut: path.join(this.context.extensionPath, 'out', 'src'),
      activeFile: vscode.window.activeTextEditor?.document.uri.fsPath
    });

    // Any terminal created from now on inherits the endpoint automatically.
    const collection = this.context.environmentVariableCollection;
    collection.clear();
    collection.description = 'Runtime Lens endpoint';
    for (const [key, value] of Object.entries(this.strategy.env)) {
      if (typeof value === 'string' && value.length > 0) {
        collection.replace(key, value);
      }
    }

    logger.info(`project: ${this.profile.frameworks.join(', ')} (${this.profile.moduleKind})`);
    logger.info(`strategy: ${this.strategy.title} — ${this.strategy.kind}`);
    if (this.strategy.command) {
      logger.info(`run: ${this.strategy.command}`);
    }
    for (const warning of [...this.profile.notes, ...this.strategy.warnings]) {
      logger.warn(warning);
    }

    void vscode.window
      .showInformationMessage(
        `Runtime Lens ready on port ${port} — ${this.strategy.title}.`,
        'Show Command',
        'Open Explorer'
      )
      .then((choice) => {
        if (choice === 'Show Command') {
          this.output.show(true);
        } else if (choice === 'Open Explorer') {
          this.showExplorerPanel();
        }
      });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = undefined;
    }
    this.context.environmentVariableCollection.clear();
    this.explorer.setSessions([]);
    this.sourceMaps.clear();
    this.decorations.setEnabled(false);
    this.statusBar.setState(this.config.enabled ? 'disconnected' : 'disabled', 'Server stopped.');
    logger.info('runtime server stopped');
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // -------------------------------------------------------------- commands

  clearLogs(): void {
    this.store.clear();
    this.diagnostics.clear();
    this.decorations.refresh();
    this.statusBar.setCounters(this.server?.listSessions().length ?? 0, 0);
    logger.info('logs cleared');
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    this.explorer.setPaused(paused);
    this.server?.broadcastConfig();
    void vscode.commands.executeCommand('setContext', 'runtimeLens.paused', paused);
    if (paused) {
      this.statusBar.setState('paused', 'Capture paused; the agent keeps running.');
    } else {
      this.statusBar.setState(
        (this.server?.listSessions().length ?? 0) > 0 ? 'active' : 'disconnected',
        'Capture resumed.'
      );
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  async toggleInlineValues(): Promise<void> {
    const next = !this.config.inlineValues;
    await updateConfig('inlineValues', next);
    this.config = readConfig();
    this.decorations.setEnabled(this.config.enabled && next);
    void vscode.window.showInformationMessage(`Runtime Lens inline values ${next ? 'enabled' : 'disabled'}.`);
  }

  showExplorerPanel(): void {
    RuntimeExplorerPanel.show(vscode.Uri.file(this.context.extensionPath), this.store, {
      reveal: (file, line) => void this.revealSource(file, line),
      clear: () => this.clearLogs(),
      setPaused: (paused) => this.setPaused(paused),
      isPaused: () => this.paused,
      setFilter: (query, levels) =>
        this.store.setFilter({ query, levels: levels ? new Set<LogLevel>(levels) : undefined })
    });
  }

  async setFilter(): Promise<void> {
    const query = await vscode.window.showInputBox({
      title: 'Runtime Lens: search captured values',
      prompt: 'Substring match over values and file paths. Empty clears the filter.',
      value: this.store.filter.query
    });
    if (query === undefined) {
      return;
    }
    this.store.setFilter({ query });
    logger.info(`filter set to "${query}"`);
  }

  toggleFollow(): void {
    const following = this.explorer.toggleFollow();
    void vscode.window.setStatusBarMessage(`Runtime Lens: follow ${following ? 'on' : 'off'}`, 2000);
  }

  async revealSource(file: string, line: number): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
      const target = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(target, target);
      editor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (err) {
      void vscode.window.showWarningMessage(`Runtime Lens could not open ${file}: ${(err as Error).message}`);
    }
  }

  async copyEventValue(node: ExplorerNode | undefined): Promise<void> {
    if (!node || node.kind !== 'event') {
      return;
    }
    await vscode.env.clipboard.writeText(eventText(node.stored.event, 100_000, 8));
    void vscode.window.showInformationMessage('Runtime Lens: value copied.');
  }

  async revealEvent(node: ExplorerNode | undefined): Promise<void> {
    if (!node || node.kind !== 'event') {
      return;
    }
    await this.revealSource(node.stored.loc.file, node.stored.loc.line);
  }

  /** Human-readable diagnostics dump; also the `Show Diagnostics` command. */
  diagnosticsReport(): string {
    const lines: string[] = [];
    const stats = this.store.stats();
    lines.push('Runtime Lens diagnostics');
    lines.push('========================');
    lines.push(`protocol            : ${PROTOCOL_VERSION}`);
    lines.push(`state               : ${this.statusBar.currentState}`);
    lines.push(`server              : ${this.server?.isRunning ? `127.0.0.1:${this.server.port}` : 'stopped'}`);
    lines.push(`uptime              : ${this.startedAt ? `${Math.round((Date.now() - this.startedAt) / 1000)}s` : 'n/a'}`);
    lines.push(`sessions            : ${this.server?.listSessions().length ?? 0}`);
    lines.push(`events (total/live) : ${stats.totalAdded}/${stats.size} (capacity ${stats.capacity}, dropped ${stats.dropped})`);
    lines.push(`probes seen         : ${stats.probes}`);
    lines.push(`decorated lines     : ${stats.lines}`);
    lines.push(`diagnostics         : ${this.diagnostics.count()}`);
    lines.push(`paused              : ${this.paused}`);
    lines.push(`inline values       : ${this.config.inlineValues}`);
    lines.push('');
    lines.push('Configuration');
    lines.push('-------------');
    for (const [key, value] of Object.entries(this.config)) {
      lines.push(`${key.padEnd(20)}: ${String(value)}`);
    }
    lines.push('');
    lines.push('Project');
    lines.push('-------');
    if (this.profile) {
      lines.push(`root                : ${this.profile.root}`);
      lines.push(`frameworks          : ${this.profile.frameworks.join(', ')}`);
      lines.push(`module kind         : ${this.profile.moduleKind}`);
      lines.push(`typescript / jsx    : ${this.profile.typescript} / ${this.profile.jsx}`);
      lines.push(`entry               : ${this.profile.entry ?? '(unknown)'}`);
      lines.push(`package manager     : ${this.profile.packageManager}`);
      lines.push(`configs             : ${JSON.stringify(this.profile.configs)}`);
      for (const note of this.profile.notes) {
        lines.push(`note                : ${note}`);
      }
    } else {
      lines.push('(no workspace analysed yet)');
    }
    lines.push('');
    lines.push('Strategy');
    lines.push('--------');
    if (this.strategy) {
      lines.push(`kind                : ${this.strategy.kind}`);
      lines.push(`title               : ${this.strategy.title}`);
      lines.push(`command             : ${this.strategy.command ?? '(manual)'}`);
      for (const warning of this.strategy.warnings) {
        lines.push(`warning             : ${warning}`);
      }
      if (this.strategy.snippet) {
        lines.push('');
        lines.push('Config snippet');
        lines.push('--------------');
        lines.push(this.strategy.snippet);
      }
    } else {
      lines.push('(not selected yet — run “Runtime Lens: Start”)');
    }
    lines.push('');
    lines.push('Sessions');
    lines.push('--------');
    for (const session of this.server?.listSessions() ?? []) {
      lines.push(
        `${session.sessionId}  ${session.runtime.padEnd(8)} ${session.transport.padEnd(5)} events=${session.eventCount} dropped=${session.droppedByAgent} ${session.label}`
      );
    }
    lines.push('');
    lines.push('Recent log');
    lines.push('----------');
    lines.push(...logger.recent(80));
    return lines.join('\n');
  }

  async showDiagnostics(): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      content: this.diagnosticsReport(),
      language: 'plaintext'
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  latestFor(file: string, line: number): StoredEvent | undefined {
    return this.store.latestAt(file, line);
  }

  dispose(): void {
    void this.stop();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
