import * as vscode from 'vscode';
import { MAX_SERIALIZED_ENTRIES } from '../protocol';
import { clampInt } from '../utils/numbers';

export interface RuntimeLensConfig {
  enabled: boolean;
  inlineValues: boolean;
  captureConsole: boolean;
  captureExpressions: boolean;
  maxInlineLength: number;
  objectDepth: number;
  maxEntries: number;
  maxNodes: number;
  maxHistory: number;
  showTimestamp: boolean;
  showExecutionCount: boolean;
  showPreviousValue: boolean;
  showValueStats: boolean;
  hoverHistory: number;
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
    maxInlineLength: clampInt(c.get<number>('maxInlineLength', 120), 10, 2000),
    objectDepth: clampInt(c.get<number>('objectDepth', 3), 0, 10),
    maxEntries: clampInt(c.get<number>('maxEntries', 100), 1, MAX_SERIALIZED_ENTRIES),
    maxNodes: clampInt(c.get<number>('maxNodes', 5000), 100, 100_000),
    maxHistory: clampInt(c.get<number>('maxHistory', 5000), 50, 100_000),
    showTimestamp: c.get<boolean>('showTimestamp', false),
    showExecutionCount: c.get<boolean>('showExecutionCount', true),
    showPreviousValue: c.get<boolean>('showPreviousValue', true),
    showValueStats: c.get<boolean>('showValueStats', true),
    hoverHistory: clampInt(c.get<number>('hoverHistory', 10), 0, 50),
    port: clampInt(c.get<number>('port', 0), 0, 65_535),
    maxPayloadBytes: clampInt(c.get<number>('maxPayloadBytes', 262_144), 4096, 4 * 1024 * 1024)
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
