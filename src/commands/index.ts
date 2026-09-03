import * as vscode from 'vscode';
import type { RuntimeLensController } from '../vscode/controller';
import type { ExplorerNode } from '../vscode/explorer';

export const COMMAND_IDS = {
  start: 'runtimeLens.start',
  stop: 'runtimeLens.stop',
  restart: 'runtimeLens.restart',
  clearLogs: 'runtimeLens.clearLogs',
  pauseCapture: 'runtimeLens.pauseCapture',
  resumeCapture: 'runtimeLens.resumeCapture',
  showRuntimeExplorer: 'runtimeLens.showRuntimeExplorer',
  toggleInlineValues: 'runtimeLens.toggleInlineValues',
  showDiagnostics: 'runtimeLens.showDiagnostics',
  setFilter: 'runtimeLens.setFilter',
  toggleFollow: 'runtimeLens.toggleFollow',
  revealEvent: 'runtimeLens.revealEvent',
  copyEventValue: 'runtimeLens.copyEventValue'
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

/**
 * Command registration is data-driven so the set of ids can be asserted in
 * tests against package.json - a class of bug (contributed command with no
 * handler) that is otherwise only discovered by a user clicking it.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  controller: RuntimeLensController
): Map<CommandId, (...args: unknown[]) => unknown> {
  const handlers = new Map<CommandId, (...args: unknown[]) => unknown>([
    [COMMAND_IDS.start, () => controller.start()],
    [COMMAND_IDS.stop, () => controller.stop()],
    [COMMAND_IDS.restart, () => controller.restart()],
    [COMMAND_IDS.clearLogs, () => controller.clearLogs()],
    [COMMAND_IDS.pauseCapture, () => controller.setPaused(true)],
    [COMMAND_IDS.resumeCapture, () => controller.setPaused(false)],
    [COMMAND_IDS.showRuntimeExplorer, () => controller.showExplorerPanel()],
    [COMMAND_IDS.toggleInlineValues, () => controller.toggleInlineValues()],
    [COMMAND_IDS.showDiagnostics, () => controller.showDiagnostics()],
    [COMMAND_IDS.setFilter, () => controller.setFilter()],
    [COMMAND_IDS.toggleFollow, () => controller.toggleFollow()],
    [COMMAND_IDS.revealEvent, (node?: unknown) => controller.revealEvent(node as ExplorerNode | undefined)],
    [COMMAND_IDS.copyEventValue, (node?: unknown) => controller.copyEventValue(node as ExplorerNode | undefined)]
  ]);

  for (const [id, handler] of handlers) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
  return handlers;
}
