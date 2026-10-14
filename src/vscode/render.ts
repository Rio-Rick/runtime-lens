import type { RuntimeEvent } from '../protocol';
import { preview, previewArgs, toMarkdownTree, truncate } from '../serialization/preview';
import { numericValueOf, type EventStore, type ProbeStats, type StoredEvent } from '../runtime/store';

export interface RenderConfig {
  maxInlineLength: number;
  showTimestamp: boolean;
  showExecutionCount: boolean;
  objectDepth: number;
  /** Append `(was X)` inline when a probe's value changed since its previous run. */
  showPreviousValue: boolean;
  /** Append `min / max / sparkline` inline for probes that produce numbers. */
  showValueStats: boolean;
  /** How many previous runs the hover lists (0 turns the history off). */
  hoverHistory: number;
}

/** Extra context for the inline text; both parts are optional and cheap to look up. */
export interface InlineExtras {
  /** The previous run of the same probe. */
  previous?: RuntimeEvent;
  /** Running numeric summary of the same probe. */
  stats?: ProbeStats;
}

/** Extra context for the hover. */
export interface HoverExtras {
  /** Recent runs of the same probe, newest first (includes the latest). */
  history: StoredEvent[];
  stats?: ProbeStats;
}

/** Command behind the hover's "all runs" link. Must match package.json / commands/index.ts. */
export const SHOW_PROBE_HISTORY_COMMAND = 'runtimeLens.showProbeHistory';

const SPARK_BARS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
/** Longest `was ...` value shown inline; the full one is always in the hover. */
const PREVIOUS_MAX_LENGTH = 24;
/** Numeric samples needed before min/max/sparkline say anything useful. */
const MIN_STATS_SAMPLES = 3;

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
 * The inline decoration text: Console Ninja's `// => value x N` idiom.
 *
 * The `x` count only appears once a probe has run more than once, so a
 * straight-line script stays visually quiet, while a loop immediately shows
 * how many iterations happened. With `extras`, a probe that changed since its
 * previous run also shows `(was X)`, and a numeric probe shows its range and a
 * small trend sparkline - both stay silent when there is nothing to say.
 */
export function inlineText(event: RuntimeEvent, config: RenderConfig, extras?: InlineExtras): string {
  const glyph = event.t === 'log' ? LEVEL_GLYPH[event.level] ?? '' : event.t === 'error' ? LEVEL_GLYPH.error : '';
  const depth = Math.min(2, config.objectDepth);
  const value = eventText(event, config.maxInlineLength, depth);
  const parts = [`// => ${glyph}${value}`];
  if (config.showExecutionCount && event.count > 1) {
    parts.push(`\u00d7 ${event.count}`);
  }
  if (config.showTimestamp) {
    parts.push(`@ ${new Date(event.ts).toLocaleTimeString()}`);
  }
  const text = parts.join(' ');
  let out = text.length > config.maxInlineLength + 24 ? `${text.slice(0, config.maxInlineLength + 23)}\u2026` : text;

  if (extras) {
    // Appended after the cap above so the extras can never be the part that
    // gets truncated away; each piece is individually bounded.
    if (config.showPreviousValue && event.count > 1 && extras.previous) {
      const before = eventText(extras.previous, config.maxInlineLength, depth);
      if (before !== value) {
        out += ` (was ${truncate(before, PREVIOUS_MAX_LENGTH)})`;
      }
    }
    if (config.showValueStats && extras.stats && numericValueOf(event) !== undefined) {
      const stats = statsText(extras.stats);
      if (stats) {
        out += ` \u00b7 ${stats}`;
      }
    }
  }
  return out;
}

/** Cheap per-event lookups for the inline text (two map reads; no history walk). */
export function inlineExtras(store: EventStore, stored: StoredEvent, config: RenderConfig): InlineExtras | undefined {
  const wantPrevious = config.showPreviousValue && stored.event.count > 1;
  const wantStats = config.showValueStats;
  if (!wantPrevious && !wantStats) {
    return undefined;
  }
  return {
    previous: wantPrevious ? store.previousOf(stored)?.event : undefined,
    stats: wantStats ? store.statsOf(stored.event.id) : undefined
  };
}

/** Hover lookups: O(hoverHistory) tail read of the probe's bucket. */
export function hoverExtras(store: EventStore, stored: StoredEvent, config: RenderConfig): HoverExtras | undefined {
  if (config.hoverHistory <= 0 && !config.showValueStats) {
    return undefined;
  }
  return {
    history: config.hoverHistory > 0 ? store.historyOf(stored.event.id, config.hoverHistory) : [],
    stats: config.showValueStats ? store.statsOf(stored.event.id) : undefined
  };
}

/** `min 3 · max 120 ▁▂▃▅▇`, or undefined while there is nothing worth showing. */
export function statsText(stats: ProbeStats): string | undefined {
  if (stats.numeric < MIN_STATS_SAMPLES || !(stats.min < stats.max)) {
    return undefined;
  }
  return `min ${formatNumber(stats.min)} \u00b7 max ${formatNumber(stats.max)} ${sparkline(stats.trail())}`;
}

/** Scale a short series onto eight block heights (flat series render as a mid-height line). */
export function sparkline(values: number[]): string {
  if (values.length === 0) {
    return '';
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) {
      lo = v;
    }
    if (v > hi) {
      hi = v;
    }
  }
  const span = hi - lo;
  let out = '';
  for (const v of values) {
    const level = span > 0 ? Math.round(((v - lo) / span) * (SPARK_BARS.length - 1)) : 3;
    out += SPARK_BARS[level];
  }
  return out;
}

/** Integers verbatim, everything else to 4 significant digits (`3.14159` -> `3.142`). */
export function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(4)));
}

/** One row of the hover history: a run of consecutive identical values collapsed together. */
export interface HistoryRow {
  fromRun: number;
  toRun: number;
  text: string;
  ts: number;
}

/**
 * Collapse a newest-first list of events into rows, merging consecutive runs
 * that printed the same thing (`#34-#35  115  x2`), so a loop that repeats a
 * value does not spend the whole hover on one line.
 */
export function collapseHistory(history: StoredEvent[], maxLength = 60): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const { event } of history) {
    const text = truncate(eventText(event, maxLength, 1), maxLength);
    const last = rows[rows.length - 1];
    if (last && last.text === text) {
      last.fromRun = event.count;
      continue;
    }
    rows.push({ fromRun: event.count, toRun: event.count, text, ts: event.ts });
  }
  return rows;
}

let clockFormat: Intl.DateTimeFormat | undefined;
let clockSecond = -1;
let clockText = '';

/**
 * Local time of day for the history rows. `toLocaleTimeString()` builds a new
 * formatter on every call (~2 us); a reused formatter plus a one-entry memo per
 * second makes the rows of a fast loop - which share a second - nearly free.
 */
function clock(ts: number): string {
  const second = Math.floor(ts / 1000);
  if (second !== clockSecond) {
    clockFormat ??= new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });
    clockText = clockFormat.format(ts);
    clockSecond = second;
  }
  return clockText;
}

/** Inline code span that cannot be broken out of by a backtick or newline in the value. */
function codeSpan(text: string): string {
  return `\`${text.replace(/`/g, "'").replace(/\r?\n/g, ' ')}\``;
}

/** Markdown used for hovers and tree tooltips: header + expandable tree. */
export function hoverMarkdown(stored: StoredEvent, config: RenderConfig, extras?: HoverExtras): string {
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
  if (extras) {
    appendInsight(lines, event.id, event.count, extras, config);
  }
  return lines.join('\n');
}

function appendInsight(lines: string[], probeId: string, totalRuns: number, extras: HoverExtras, config: RenderConfig): void {
  const stats = extras.stats;
  if (config.showValueStats && stats && stats.numeric >= MIN_STATS_SAMPLES) {
    const avg = stats.avg;
    const bits = [`min ${formatNumber(stats.min)}`, `max ${formatNumber(stats.max)}`];
    if (avg !== undefined) {
      bits.push(`avg ${formatNumber(avg)}`);
    }
    bits.push(`${stats.numeric} samples`);
    lines.push('');
    lines.push(`**Numeric** \u2014 ${bits.join(' \u00b7 ')} ${sparkline(stats.trail())}`);
  }
  if (config.hoverHistory > 0 && extras.history.length > 1) {
    const rows = collapseHistory(extras.history);
    lines.push('');
    lines.push(`**History** \u2014 last ${extras.history.length} of ${totalRuns} runs`);
    for (const row of rows) {
      const run = row.fromRun === row.toRun ? `#${row.toRun}` : `#${row.fromRun}\u2013#${row.toRun}`;
      const repeat = row.toRun > row.fromRun ? ` \u00d7${row.toRun - row.fromRun + 1}` : '';
      lines.push(`- ${codeSpan(run)} ${codeSpan(row.text)}${repeat} \u00b7 ${clock(row.ts)}`);
    }
  }
  if (totalRuns > 1) {
    // Rows above are shortened one-liners; this opens every retained run with its full value.
    const args = encodeURIComponent(JSON.stringify([probeId]));
    lines.push('');
    lines.push(`[$(list-flat) Open all ${totalRuns} runs with full values in Runtime Explorer](command:${SHOW_PROBE_HISTORY_COMMAND}?${args})`);
  }
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
