export type LogSink = (line: string) => void;

/** Tiny leveled logger; the extension wires the sink to an OutputChannel. */
export class Logger {
  private sinks: LogSink[] = [];
  private history: string[] = [];

  constructor(private readonly name: string, private readonly historyLimit = 500) {}

  addSink(sink: LogSink): void {
    this.sinks.push(sink);
    for (const line of this.history) {
      sink(line);
    }
  }

  private write(level: string, message: string): void {
    const line = `[${new Date().toISOString()}] [${level}] [${this.name}] ${message}`;
    this.history.push(line);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }
    for (const sink of this.sinks) {
      sink(line);
    }
  }

  info(message: string): void {
    this.write('info', message);
  }

  warn(message: string): void {
    this.write('warn', message);
  }

  error(message: string, err?: unknown): void {
    const detail = err instanceof Error ? ` :: ${err.message}\n${err.stack ?? ''}` : err ? ` :: ${String(err)}` : '';
    this.write('error', `${message}${detail}`);
  }

  debug(message: string): void {
    this.write('debug', message);
  }

  recent(limit = 200): string[] {
    return this.history.slice(-limit);
  }
}

export const logger = new Logger('runtime-lens');
