import type { SerializedValue } from '../protocol';

export interface PreviewOptions {
  /** Hard cap on the returned string length (inline decorations). */
  maxLength: number;
  /** Depth at which nested containers collapse to a summary. */
  depth: number;
  /** Quote strings (`'a'`) or print them bare (`a`). */
  quoteStrings: boolean;
}

const DEFAULTS: PreviewOptions = { maxLength: 120, depth: 2, quoteStrings: true };

/** One-line, human-readable rendering used for inline decorations and labels. */
export function preview(value: SerializedValue, options: Partial<PreviewOptions> = {}): string {
  const opts = { ...DEFAULTS, ...options };
  const text = render(value, opts, 0);
  return truncate(text, opts.maxLength);
}

/** Join multiple console arguments the way a devtools console would. */
export function previewArgs(values: SerializedValue[], options: Partial<PreviewOptions> = {}): string {
  const opts = { ...DEFAULTS, ...options };
  const parts = values.map((v) => render(v, { ...opts, quoteStrings: v.k !== 'string' ? opts.quoteStrings : false }, 0));
  return truncate(parts.join(' '), opts.maxLength);
}

export function truncate(text: string, maxLength: number): string {
  const flat = text.replace(/\r?\n/g, '\u21b5 ');
  if (flat.length <= maxLength) {
    return flat;
  }
  return `${flat.slice(0, Math.max(1, maxLength - 1))}\u2026`;
}

function render(value: SerializedValue, opts: PreviewOptions, depth: number): string {
  switch (value.k) {
    case 'string':
      return opts.quoteStrings ? `'${escapeString(value.v)}'${value.truncated ? '…' : ''}` : value.v;
    case 'number':
      return String(value.v);
    case 'boolean':
      return value.v ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'bigint':
      return value.v;
    case 'symbol':
      return value.v;
    case 'date':
      return `Date(${value.v})`;
    case 'regexp':
      return value.v;
    case 'function':
      return value.kind === 'class' ? `class ${value.name}` : `ƒ ${value.name}(${value.arity})`;
    case 'error':
      return `${value.name}: ${value.message}`;
    case 'circular':
      return `[Circular → ${value.path}]`;
    case 'maxdepth':
      return value.hint;
    case 'unserializable':
      return `[${value.hint}]`;
    case 'array': {
      if (depth >= opts.depth) {
        return `Array(${value.length})`;
      }
      const inner = value.entries.map((e) => render(e, opts, depth + 1));
      if (value.truncated) {
        inner.push(`…+${value.length - value.entries.length}`);
      }
      return `[${inner.join(', ')}]`;
    }
    case 'set': {
      if (depth >= opts.depth) {
        return `Set(${value.size})`;
      }
      const inner = value.entries.map((e) => render(e, opts, depth + 1));
      if (value.truncated) {
        inner.push(`…+${value.size - value.entries.length}`);
      }
      return `Set(${value.size}) {${inner.join(', ')}}`;
    }
    case 'map': {
      if (depth >= opts.depth) {
        return `Map(${value.size})`;
      }
      const inner = value.entries.map(([k, v]) => `${render(k, opts, depth + 1)} => ${render(v, opts, depth + 1)}`);
      if (value.truncated) {
        inner.push(`…+${value.size - value.entries.length}`);
      }
      return `Map(${value.size}) {${inner.join(', ')}}`;
    }
    case 'object': {
      const prefix = value.ctor ? `${value.ctor} ` : '';
      if (depth >= opts.depth) {
        return `${prefix}{…}`;
      }
      const inner = value.entries.map(([k, v]) => `${k}: ${render(v, opts, depth + 1)}`);
      if (value.truncated) {
        inner.push(`…+${value.size - value.entries.length}`);
      }
      return `${prefix}{ ${inner.join(', ')} }`;
    }
    default:
      return '[unknown]';
  }
}

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

/**
 * Expandable tree rendering for hovers. Markdown nested lists give us a free
 * collapsible object inspector inside a VS Code hover without a webview.
 */
export function toMarkdownTree(value: SerializedValue, maxDepth = 6, indent = 0, label?: string): string {
  const pad = '  '.repeat(indent);
  const head = label !== undefined ? `**${label}**: ` : '';
  const scalar = (text: string): string => `${pad}- ${head}\`${text}\`\n`;

  switch (value.k) {
    case 'array':
    case 'set': {
      const size = value.k === 'array' ? value.length : value.size;
      let out = `${pad}- ${head}\`${value.k === 'array' ? 'Array' : 'Set'}(${size})\`\n`;
      if (indent >= maxDepth) {
        return out;
      }
      value.entries.forEach((entry, i) => {
        out += toMarkdownTree(entry, maxDepth, indent + 1, String(i));
      });
      if (value.truncated) {
        out += `${'  '.repeat(indent + 1)}- _…truncated_\n`;
      }
      return out;
    }
    case 'object': {
      let out = `${pad}- ${head}\`${value.ctor ?? 'Object'} {${value.size}}\`\n`;
      if (indent >= maxDepth) {
        return out;
      }
      for (const [key, entry] of value.entries) {
        out += toMarkdownTree(entry, maxDepth, indent + 1, key);
      }
      if (value.truncated) {
        out += `${'  '.repeat(indent + 1)}- _…truncated_\n`;
      }
      return out;
    }
    case 'map': {
      let out = `${pad}- ${head}\`Map(${value.size})\`\n`;
      if (indent >= maxDepth) {
        return out;
      }
      value.entries.forEach(([k, v], i) => {
        out += toMarkdownTree(v, maxDepth, indent + 1, `${preview(k, { maxLength: 40 })} (#${i})`);
      });
      return out;
    }
    case 'error': {
      let out = `${pad}- ${head}\`${value.name}: ${value.message}\`\n`;
      if (value.stack) {
        const firstFrames = value.stack.split('\n').slice(1, 4).map((l) => l.trim());
        for (const frame of firstFrames) {
          out += `${'  '.repeat(indent + 1)}- \`${frame}\`\n`;
        }
      }
      return out;
    }
    default:
      return scalar(preview(value, { maxLength: 200 }));
  }
}

/** Plain-JSON-ish text used by "Copy Value". */
export function toPlainText(value: SerializedValue, indent = 0): string {
  const pad = '  '.repeat(indent);
  switch (value.k) {
    case 'array':
    case 'set':
      return `[\n${value.entries.map((e) => `${pad}  ${toPlainText(e, indent + 1)}`).join(',\n')}\n${pad}]`;
    case 'object':
      return `{\n${value.entries
        .map(([k, v]) => `${pad}  ${JSON.stringify(k)}: ${toPlainText(v, indent + 1)}`)
        .join(',\n')}\n${pad}}`;
    case 'map':
      return `Map {\n${value.entries
        .map(([k, v]) => `${pad}  ${toPlainText(k, indent + 1)} => ${toPlainText(v, indent + 1)}`)
        .join(',\n')}\n${pad}}`;
    case 'string':
      return JSON.stringify(value.v);
    default:
      return preview(value, { maxLength: 10_000, depth: 1 });
  }
}
