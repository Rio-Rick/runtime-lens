import * as fs from 'node:fs';
import * as path from 'node:path';
import { TraceMap, originalPositionFor, type EncodedSourceMap } from '@jridgewell/trace-mapping';
import type { SourceLocation } from '../protocol';
import { normalizePath } from '../utils/paths';

const SOURCE_MAPPING_URL = /[#@]\s*sourceMappingURL=([^\s'"]+)/g;
const INLINE_MAP = /^data:application\/json[^,]*;base64,(.*)$/;

export interface ResolvedLocation extends SourceLocation {
  /** True when a source map actually moved the position. */
  remapped: boolean;
  /** The map chain that was applied, newest first (for diagnostics). */
  via?: string[];
}

/**
 * Maps positions reported by a running process back to the file the developer
 * is looking at.
 *
 * Two-tier strategy:
 *  1. **Registered maps.** When Runtime Lens itself transforms a file it hands
 *     the resulting map to the resolver, so remapping needs no disk access and
 *     works for in-memory bundler pipelines.
 *  2. **Discovered maps.** Otherwise we read the generated file, follow its
 *     `sourceMappingURL` (inline base64 or sibling `.map`) and trace through.
 *
 * The chain is followed up to `maxHops` times, because a Next.js file can be
 * TS -> SWC -> webpack, and each hop has its own map.
 */
export class SourceMapResolver {
  private readonly registered = new Map<string, TraceMap>();
  private readonly discovered = new Map<string, TraceMap | null>();
  private readonly negative = new Set<string>();

  constructor(private readonly maxHops = 4, private readonly fsImpl: Pick<typeof fs, 'existsSync' | 'readFileSync'> = fs) {}

  registerMap(generatedFile: string, rawMap: unknown): void {
    const key = normalizePath(generatedFile);
    const map = toTraceMap(rawMap);
    if (map) {
      this.registered.set(key, map);
      this.negative.delete(key);
    }
  }

  unregister(generatedFile: string): void {
    const key = normalizePath(generatedFile);
    this.registered.delete(key);
    this.discovered.delete(key);
  }

  clear(): void {
    this.registered.clear();
    this.discovered.clear();
    this.negative.clear();
  }

  resolve(loc: SourceLocation): ResolvedLocation {
    let current: SourceLocation = { ...loc };
    const via: string[] = [];
    // A map must never be applied twice to the same file: our own transform
    // maps `foo.ts` (generated) back to `foo.ts` (original), so a naive walk
    // would re-apply the map and land on a nonsense line.
    const visited = new Set<string>();

    for (let hop = 0; hop < this.maxHops; hop++) {
      const key = normalizePath(current.file);
      if (visited.has(key)) {
        break;
      }
      visited.add(key);
      const map = this.registered.get(key) ?? this.discover(key);
      if (!map) {
        break;
      }
      const original = originalPositionFor(map, {
        line: current.line,
        // trace-mapping expects 0-based columns, matching our protocol.
        column: current.column
      });
      if (!original || original.source == null || original.line == null) {
        break;
      }
      const resolvedSource = path.isAbsolute(original.source)
        ? original.source
        : path.resolve(path.dirname(current.file), original.source.replace(/^webpack:\/\/\/?/, ''));
      const next: SourceLocation = {
        file: normalizePath(resolvedSource),
        line: original.line,
        column: original.column ?? 0
      };
      if (next.file === key && next.line === current.line && next.column === current.column) {
        break;
      }
      via.push(key);
      current = next;
    }

    return {
      ...current,
      remapped: via.length > 0,
      via: via.length > 0 ? via : undefined
    };
  }

  private discover(generatedFile: string): TraceMap | null {
    if (this.discovered.has(generatedFile)) {
      return this.discovered.get(generatedFile) ?? null;
    }
    if (this.negative.has(generatedFile)) {
      return null;
    }
    let map: TraceMap | null = null;
    try {
      if (this.fsImpl.existsSync(generatedFile)) {
        const source = this.fsImpl.readFileSync(generatedFile, 'utf8');
        const url = lastSourceMappingUrl(source);
        if (url) {
          const inline = INLINE_MAP.exec(url);
          if (inline) {
            map = toTraceMap(JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8')));
          } else {
            const mapPath = path.resolve(path.dirname(generatedFile), url);
            if (this.fsImpl.existsSync(mapPath)) {
              map = toTraceMap(JSON.parse(this.fsImpl.readFileSync(mapPath, 'utf8')));
            }
          }
        }
        if (!map) {
          const sibling = `${generatedFile}.map`;
          if (this.fsImpl.existsSync(sibling)) {
            map = toTraceMap(JSON.parse(this.fsImpl.readFileSync(sibling, 'utf8')));
          }
        }
      }
    } catch {
      map = null;
    }
    if (map) {
      this.discovered.set(generatedFile, map);
    } else {
      this.negative.add(generatedFile);
    }
    return map;
  }
}

export function lastSourceMappingUrl(source: string): string | undefined {
  SOURCE_MAPPING_URL.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = SOURCE_MAPPING_URL.exec(source)) !== null) {
    last = match[1];
  }
  return last;
}

function toTraceMap(rawMap: unknown): TraceMap | null {
  try {
    if (!rawMap) {
      return null;
    }
    const parsed = typeof rawMap === 'string' ? (JSON.parse(rawMap) as unknown) : rawMap;
    return new TraceMap(parsed as EncodedSourceMap);
  } catch {
    return null;
  }
}

/** Append an inline base64 source map comment (used by the Node loader hook). */
export function appendInlineSourceMap(code: string, map: unknown): string {
  if (!map) {
    return code;
  }
  const json = typeof map === 'string' ? map : JSON.stringify(map);
  const base64 = Buffer.from(json, 'utf8').toString('base64');
  return `${code}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`;
}
