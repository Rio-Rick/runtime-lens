import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { readConfig } from './vscode/config';
import { RuntimeLensController } from './vscode/controller';
import { logger } from './utils/logger';
import { PROTOCOL_VERSION } from './protocol';

let controller: RuntimeLensController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<{ controller: RuntimeLensController }> {
  logger.info(`activating runtime-lens (protocol ${PROTOCOL_VERSION})`);
  controller = new RuntimeLensController(context);
  context.subscriptions.push(controller);
  registerCommands(context, controller);

  const config = readConfig();
  if (config.enabled) {
    // Auto-start: the server is a few hundred bytes of state and one localhost
    // socket, and requiring an explicit Start for every window is friction.
    await controller.start();
  } else {
    logger.info('runtimeLens.enabled is false; not starting the runtime server');
  }
  return { controller };
}

export async function deactivate(): Promise<void> {
  logger.info('deactivating runtime-lens');
  await controller?.stop();
  controller = undefined;
}
