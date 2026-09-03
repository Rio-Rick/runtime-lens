import * as vscode from 'vscode';
import type { RuntimeEvent } from '../protocol';
import type { StoredEvent } from '../runtime/store';

/**
 * Surfaces captured runtime failures in the Problems panel.
 *
 * Only two things become diagnostics: real runtime errors (uncaught
 * exceptions, rejected promises) and `console.error` calls. Everything else
 * would be noise. Entries are keyed per file so a re-run replaces them instead
 * of accumulating.
 */
export class RuntimeDiagnostics implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private readonly perFile = new Map<string, vscode.Diagnostic[]>();

  constructor(private readonly limitPerFile = 50) {
    this.collection = vscode.languages.createDiagnosticCollection('runtime-lens');
  }

  report(events: StoredEvent[]): void {
    const touched = new Set<string>();
    for (const stored of events) {
      const diagnostic = toDiagnostic(stored.event, stored.loc.line);
      if (!diagnostic) {
        continue;
      }
      const file = stored.loc.file;
      const list = this.perFile.get(file) ?? [];
      if (!list.some((d) => d.message === diagnostic.message && d.range.isEqual(diagnostic.range))) {
        list.push(diagnostic);
      }
      while (list.length > this.limitPerFile) {
        list.shift();
      }
      this.perFile.set(file, list);
      touched.add(file);
    }
    for (const file of touched) {
      this.collection.set(vscode.Uri.file(file), this.perFile.get(file) ?? []);
    }
  }

  clear(): void {
    this.perFile.clear();
    this.collection.clear();
  }

  count(): number {
    let total = 0;
    for (const list of this.perFile.values()) {
      total += list.length;
    }
    return total;
  }

  dispose(): void {
    this.collection.dispose();
  }
}

export function toDiagnostic(event: RuntimeEvent, line: number): vscode.Diagnostic | undefined {
  const zeroBased = Math.max(0, line - 1);
  const range = new vscode.Range(zeroBased, 0, zeroBased, Number.MAX_SAFE_INTEGER);
  if (event.t === 'error') {
    const diagnostic = new vscode.Diagnostic(
      range,
      event.message,
      event.fatal ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
    );
    diagnostic.source = 'Runtime Lens';
    diagnostic.code = event.fatal ? 'uncaught' : 'unhandled-rejection';
    return diagnostic;
  }
  if (event.t === 'log' && event.level === 'error') {
    const first = event.args[0];
    const message =
      first && first.k === 'error' ? `${first.name}: ${first.message}` : `console.error at line ${line}`;
    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Information);
    diagnostic.source = 'Runtime Lens';
    diagnostic.code = 'console.error';
    return diagnostic;
  }
  return undefined;
}
