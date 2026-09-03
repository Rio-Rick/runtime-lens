import * as path from 'node:path';

/** Directories that must never be instrumented, no matter how we are invoked. */
export const EXCLUDED_DIR_SEGMENTS: readonly string[] = [
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.vercel',
  '.cache',
  'dist',
  'build',
  'out',
  'coverage',
  '.git'
];

export const INSTRUMENTABLE_EXTENSIONS: readonly string[] = [
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts'
];

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * The single chokepoint that answers "may we rewrite this file?".
 * Every entry point (Vite plugin, Node loader, extension host) funnels
 * through here so the exclusion rules cannot drift apart.
 */
export function shouldInstrument(filePath: string, opts: { extraExcludes?: readonly string[] } = {}): boolean {
  if (!filePath) {
    return false;
  }
  const normalized = normalizePath(filePath).split('?')[0].split('#')[0];
  if (normalized.startsWith('\0') || normalized.includes('\0')) {
    return false; // virtual/rollup-internal module ids
  }
  if (normalized.startsWith('virtual:') || normalized.startsWith('data:')) {
    return false;
  }
  const ext = path.posix.extname(normalized).toLowerCase();
  if (!INSTRUMENTABLE_EXTENSIONS.includes(ext)) {
    return false;
  }
  if (/\.d\.[cm]?ts$/.test(normalized)) {
    return false;
  }
  const segments = normalized.split('/');
  const excluded = [...EXCLUDED_DIR_SEGMENTS, ...(opts.extraExcludes ?? [])];
  for (const segment of segments.slice(0, -1)) {
    if (excluded.includes(segment)) {
      return false;
    }
  }
  const base = segments[segments.length - 1];
  if (base.endsWith('.min.js') || base.endsWith('.bundle.js')) {
    return false;
  }
  return true;
}

/** True when a file cannot be executed by bare `node` (JSX syntax). */
export function requiresJsxCapableRuntime(filePath: string): boolean {
  const ext = path.posix.extname(normalizePath(filePath)).toLowerCase();
  return ext === '.tsx' || ext === '.jsx';
}

export function relativeToRoot(root: string, file: string): string {
  const rel = path.relative(root, file);
  return rel.startsWith('..') ? normalizePath(file) : normalizePath(rel);
}
