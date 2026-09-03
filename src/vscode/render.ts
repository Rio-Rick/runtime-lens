import type { RuntimeEvent } from '../protocol';
import { preview, previewArgs, toMarkdownTree } from '../serialization/preview';
import type { StoredEvent } from '../runtime/store';

export interface RenderConfig {
  maxInlineLength: number;
  showTimestamp: boolean;
  showExecutionCount: boolean;
  objectDepth: number;
}

const LEVEL_GLYPH: Record<string, string> = {
  log: '',
  info: 'ℹ ',
  warn: '⚠ ',
  error: '✖ ',
  debug: '· ',
  table: '▦ '
};

/** Plain text of an event's value(s), used for search, tree labels and copy. */
export function eventText(event: RuntimeEvent, maxLength = 400, depth = 2): string {
  switch (event.t) {
    case 'log':
      return previewArgs(event.args, { maxLength, depth });
    case 'expr':
      return preview(event.value, { maxLength, depth });
    case 'error':
      return event.message;
    default:
      return '';
  }
}

/**
 * The inline decoration text: Console Ninja's `// => value × N` idiom.
 *
 * The `×` count only appears once a probe has run more than once, so a
 * straight-line script stays visually quiet, while a loop immediately shows
 * how many iterations happened.
 */
export function inlineText(event: RuntimeEvent, config: RenderConfig): string {
  const glyph = event.t === 'log' ? LEVEL_GLYPH[event.level] ?? '' : event.t === 'error' ? LEVEL_GLYPH.error : '';
  const value = eventText(event, config.maxInlineLength, Math.min(2, config.objectDepth));
  const parts = [`// => ${glyph}${value}`];
  if (config.showExecutionCount && event.count > 1) {
    parts.push(`× ${event.count}`);
  }
  if (config.showTimestamp) {
    parts.push(`@ ${new Date(event.ts).toLocaleTimeString()}`);
  }
  const text = parts.join(' ');
  return text.length > config.maxInlineLength + 24 ? `${text.slice(0, config.maxInlineLength + 23)}…` : text;
}

/** Markdown used for hovers and tree tooltips: header + expandable tree. */
export function hoverMarkdown(stored: StoredEvent, config: RenderConfig): string {
  const { event } = stored;
  const treeDepth = Math.max(2, config.objectDepth + 3);
  const lines: string[] = [];
  const kind = event.t === 'log' ? `console.${event.level}` : event.t === 'expr' ? 'probe' : 'runtime error';
  lines.push(`**Runtime Lens** — \`${kind}\``);
  lines.push('');
  const meta = [`line ${stored.loc.line}`, `× ${event.count}`, new Date(event.ts).toLocaleTimeString()];
  if (stored.remapped) {
    meta.push('source-mapped');
  }
  lines.push(`_${meta.join(' · ')}_`);
  lines.push('');
  if (event.t === 'log') {
    event.args.forEach((arg, index) => {
      const label = event.exprs?.[index] ?? `arg ${index}`;
      lines.push(toMarkdownTree(arg, treeDepth, 0, event.args.length > 1 ? label : undefined).trimEnd());
    });
  } else if (event.t === 'expr') {
    lines.push(`\`${event.expr}\``);
    lines.push('');
    lines.push(toMarkdownTree(event.value, treeDepth).trimEnd());
  } else {
    lines.push('```');
    lines.push(event.stack ?? event.message);
    lines.push('```');
  }
  return lines.join('\n');
}

export function levelIcon(event: RuntimeEvent): string {
  if (event.t === 'error') {
    return 'error';
  }
  if (event.t === 'expr') {
    return 'symbol-variable';
  }
  switch (event.level) {
    case 'error':
      return 'error';
    case 'warn':
      return 'warning';
    case 'info':
      return 'info';
    case 'debug':
      return 'debug';
    case 'table':
      return 'table';
    default:
      return 'output';
  }
}
