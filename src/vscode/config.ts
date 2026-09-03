import * as vscode from 'vscode';

export interface RuntimeLensConfig {
  enabled: boolean;
  inlineValues: boolean;
  captureConsole: boolean;
  captureExpressions: boolean;
  maxInlineLength: number;
  objectDepth: number;
  maxHistory: number;
  showTimestamp: boolean;
  showExecutionCount: boolean;
  port: number;
  maxPayloadBytes: number;
}

export const CONFIG_SECTION = 'runtimeLens';

export function readConfig(scope?: vscode.ConfigurationScope): RuntimeLensConfig {
  const c = vscode.workspace.getConfiguration(CONFIG_SECTION, scope);
  return {
    enabled: c.get<boolean>('enabled', true),
    inlineValues: c.get<boolean>('inlineValues', true),
    captureConsole: c.get<boolean>('captureConsole', true),
    captureExpressions: c.get<boolean>('captureExpressions', true),
    maxInlineLength: clamp(c.get<number>('maxInlineLength', 120), 10, 2000),
    objectDepth: clamp(c.get<number>('objectDepth', 3), 0, 10),
    maxHistory: clamp(c.get<number>('maxHistory', 5000), 50, 100_000),
    showTimestamp: c.get<boolean>('showTimestamp', false),
    showExecutionCount: c.get<boolean>('showExecutionCount', true),
    port: clamp(c.get<number>('port', 0), 0, 65_535),
    maxPayloadBytes: clamp(c.get<number>('maxPayloadBytes', 262_144), 4096, 4 * 1024 * 1024)
  };
}

export async function updateConfig<K extends keyof RuntimeLensConfig>(
  key: K,
  value: RuntimeLensConfig[K]
): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(key, value, vscode.ConfigurationTarget.Workspace);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
