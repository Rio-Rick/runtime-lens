import * as fs from 'node:fs';
import * as path from 'node:path';

export type FrameworkId =
  | 'next-app'
  | 'next-pages'
  | 'next-hybrid'
  | 'react'
  | 'vite'
  | 'webpack'
  | 'express'
  | 'fastify'
  | 'nestjs'
  | 'node';

export type ModuleKind = 'esm' | 'cjs';

export interface DetectedConfigFiles {
  next?: string;
  vite?: string;
  webpack?: string;
  tsconfig?: string;
  jsconfig?: string;
  packageJson?: string;
}

export interface ProjectProfile {
  root: string;
  /** All frameworks detected, most specific first. */
  frameworks: FrameworkId[];
  /** The framework that decides the integration strategy. */
  primary: FrameworkId;
  moduleKind: ModuleKind;
  typescript: boolean;
  jsx: boolean;
  configs: DetectedConfigFiles;
  /** Entry point guess, relative to root. */
  entry?: string;
  /** Router layout for Next.js projects. */
  nextRouters: Array<'app' | 'pages'>;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  dependencies: Record<string, string>;
  scripts: Record<string, string>;
  notes: string[];
}

export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  readdirSync?(p: string): string[];
}

const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'];
const VITE_CONFIGS = ['vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.ts', 'vite.config.mts'];
const WEBPACK_CONFIGS = ['webpack.config.js', 'webpack.config.mjs', 'webpack.config.cjs', 'webpack.config.ts'];
const ENTRY_CANDIDATES = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.js',
  'src/index.jsx',
  'src/main.ts',
  'src/main.tsx',
  'src/main.js',
  'src/server.ts',
  'src/server.js',
  'src/app.ts',
  'src/app.js',
  'index.ts',
  'index.js',
  'index.mjs',
  'index.cjs',
  'server.ts',
  'server.js',
  'app.js'
];

function readJson(fsImpl: FsLike, file: string): Record<string, unknown> | undefined {
  try {
    if (!fsImpl.existsSync(file)) {
      return undefined;
    }
    // Strip trailing commas + line comments so tsconfig/jsconfig (JSONC) parse.
    const raw = fsImpl
      .readFileSync(file, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function firstExisting(fsImpl: FsLike, root: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    if (fsImpl.existsSync(path.join(root, name))) {
      return name;
    }
  }
  return undefined;
}

/**
 * Detect what kind of project this is from *evidence on disk only*.
 *
 * Ordering matters: Next.js must win over React and Vite, because Next brings
 * its own compiler and its own dev server, and attaching a Vite plugin to a
 * Next project is a guaranteed misfire. Detection is pure and fs-injectable so
 * every branch is unit-testable without creating real directories.
 */
export function detectProject(root: string, fsImpl: FsLike = fs): ProjectProfile {
  const notes: string[] = [];
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJson(fsImpl, pkgPath) ?? {};
  const dependencies: Record<string, string> = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {})
  };
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};

  const configs: DetectedConfigFiles = {
    packageJson: fsImpl.existsSync(pkgPath) ? 'package.json' : undefined,
    next: firstExisting(fsImpl, root, NEXT_CONFIGS),
    vite: firstExisting(fsImpl, root, VITE_CONFIGS),
    webpack: firstExisting(fsImpl, root, WEBPACK_CONFIGS),
    tsconfig: firstExisting(fsImpl, root, ['tsconfig.json']),
    jsconfig: firstExisting(fsImpl, root, ['jsconfig.json'])
  };

  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(dependencies, name);

  const nextRouters: Array<'app' | 'pages'> = [];
  for (const dir of ['app', 'src/app']) {
    if (fsImpl.existsSync(path.join(root, dir))) {
      nextRouters.push('app');
      break;
    }
  }
  for (const dir of ['pages', 'src/pages']) {
    if (fsImpl.existsSync(path.join(root, dir))) {
      nextRouters.push('pages');
      break;
    }
  }

  const frameworks: FrameworkId[] = [];
  const isNext = has('next') || configs.next !== undefined;
  if (isNext) {
    if (nextRouters.includes('app') && nextRouters.includes('pages')) {
      frameworks.push('next-hybrid');
      notes.push('Both app/ and pages/ routers found: instrumentation is applied to both trees.');
    } else if (nextRouters.includes('app')) {
      frameworks.push('next-app');
    } else if (nextRouters.includes('pages')) {
      frameworks.push('next-pages');
    } else {
      frameworks.push('next-pages');
      notes.push('next detected but no app/ or pages/ directory found; assuming pages router.');
    }
  }
  if (has('vite') || configs.vite !== undefined) {
    frameworks.push('vite');
  }
  if (has('react') || has('react-dom')) {
    frameworks.push('react');
  }
  if (has('webpack') || configs.webpack !== undefined) {
    frameworks.push('webpack');
  }
  if (has('@nestjs/core')) {
    frameworks.push('nestjs');
  }
  if (has('fastify')) {
    frameworks.push('fastify');
  }
  if (has('express')) {
    frameworks.push('express');
  }
  frameworks.push('node');

  const tsconfig = configs.tsconfig ? readJson(fsImpl, path.join(root, configs.tsconfig)) : undefined;
  const compilerOptions = (tsconfig?.compilerOptions as Record<string, unknown> | undefined) ?? {};
  const entryFromPkgRaw = typeof pkg.main === 'string' ? pkg.main : undefined;
  const entryLooksTyped = /\.(ts|tsx|mts|cts)$/.test(entryFromPkgRaw ?? '');
  const typescript = configs.tsconfig !== undefined || has('typescript') || entryLooksTyped;
  const jsxFromTsconfig = typeof compilerOptions.jsx === 'string';
  const jsx = jsxFromTsconfig || has('react') || isNext || has('preact');

  const declaredType = pkg.type === 'module' ? 'esm' : pkg.type === 'commonjs' ? 'cjs' : undefined;
  const moduleKind: ModuleKind = declaredType ?? (isNext || frameworks.includes('vite') ? 'esm' : 'cjs');
  if (!declaredType) {
    notes.push(`package.json has no "type" field; assuming ${moduleKind}.`);
  }

  const entryFromPkg = entryFromPkgRaw;
  const entry =
    (entryFromPkg && fsImpl.existsSync(path.join(root, entryFromPkg)) ? entryFromPkg : undefined) ??
    ENTRY_CANDIDATES.find((candidate) => fsImpl.existsSync(path.join(root, candidate)));

  const packageManager: ProjectProfile['packageManager'] = fsImpl.existsSync(path.join(root, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : fsImpl.existsSync(path.join(root, 'yarn.lock'))
      ? 'yarn'
      : fsImpl.existsSync(path.join(root, 'bun.lockb'))
        ? 'bun'
        : 'npm';

  return {
    root,
    frameworks,
    primary: frameworks[0],
    moduleKind,
    typescript,
    jsx,
    configs,
    entry,
    nextRouters,
    packageManager,
    dependencies,
    scripts,
    notes
  };
}
