import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { hashManifest } from './hash.js';
import { readManifestObject } from './read.js';
import type { Manifest, SourceRef } from './types.js';

/** DI key the runtime manifest is registered under. */
export const MANIFEST_TOKEN = '__manifest__';

export type ManifestMode = 'off' | 'prefer' | 'require';
const MODES: readonly string[] = ['off', 'prefer', 'require'];

export interface ManifestRuntimeOptions {
  path: string;
  mode: ManifestMode;
  /** Receives the stale-manifest fallback notice in `prefer` mode; defaults to console.warn. */
  warn?: (message: string) => void;
}

export class ManifestMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestMissing';
  }
}

/**
 * Reads the manifest named by `options.path` (relative paths against `cwd`). `off` never reads,
 * `prefer` tolerates a missing file, `require` throws ManifestMissing.
 */
export function loadRuntimeManifest(options: ManifestRuntimeOptions, cwd = process.cwd()): Manifest | undefined {
  if (!MODES.includes(options.mode)) {
    throw new Error(`system.manifest.mode '${String(options.mode)}' is not valid; allowed values: ${MODES.join(', ')}`);
  }
  if (options.mode === 'off') {
    return undefined;
  }

  const file = isAbsolute(options.path) ? options.path : resolve(cwd, options.path);
  if (!existsSync(file)) {
    if (options.mode === 'require') {
      throw new ManifestMissing(`system.manifest.mode is 'require' but ${file} does not exist; run 'spinajs build' first`);
    }
    return undefined;
  }

  const manifest = readManifestObject(JSON.parse(readFileSync(file, 'utf8')), file);
  if (hashManifest(manifest) !== manifest.hash) {
    const message = `${file} is stale or edited: hash mismatch, run spinajs build`;
    if (options.mode === 'require') {
      throw new Error(message);
    }
    (options.warn ?? console.warn)(`${message}; falling back to discovery`);
    return undefined;
  }
  return manifest;
}

/** Root of the app itself. SPINAJS_MANIFEST_ROOT re-bases a manifest built elsewhere (bundle, container image). */
export function appRootOf(manifest: Manifest, cwd: string): string {
  const override = process.env.SPINAJS_MANIFEST_ROOT;
  if (override) {
    return resolve(override);
  }
  return existsSync(manifest.app.root) ? manifest.app.root : resolve(cwd);
}

/** Root directory of a package listed in `manifest.packages`, resolved from the app root the way node resolves it. */
export function packageRootOf(name: string, manifest: Manifest, cwd: string): string {
  if (name === manifest.app.name) {
    return appRootOf(manifest, cwd);
  }

  const listed = manifest.packages.find((p) => p.name === name);
  if (!listed) {
    throw new ManifestMissing(`package ${name} is referenced by a manifest entry but is not listed in manifest.packages`);
  }

  const require = createRequire(join(appRootOf(manifest, cwd), 'package.json'));
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Package without `package.json` in its exports: peel `listed.entry` (e.g. `lib/index.js`) off the resolved main.
    const entry = require.resolve(name);
    const suffix = `${sep}${listed.entry.split('/').join(sep)}`;
    if (!entry.endsWith(suffix)) {
      throw new ManifestMissing(`cannot locate the root of package ${name}: resolved entry ${entry} does not end with ${listed.entry}`);
    }
    return entry.slice(0, entry.length - suffix.length);
  }
}

/**
 * Built file of a manifest entry: `src/x/y.ts` of package P becomes `<root of P>/<outDir>/x/y.js`.
 * A source already under `<outDir>/` (hand-written test manifests) keeps its directory.
 */
export function manifestFileFor(entry: { source: SourceRef }, manifest: Manifest, cwd: string): string {
  const pkg = entry.source.package;
  const root = packageRootOf(pkg, manifest, cwd);
  const outDir = pkg === manifest.app.name ? manifest.app.outDir : (manifest.packages.find((p) => p.name === pkg)?.outDir ?? 'lib');
  const escapes = (what: string, value: string): ManifestMissing =>
    new ManifestMissing(`manifest entry from ${pkg} (${entry.source.file}): ${what} '${value}' leaves the root ${root}`);

  if (isAbsolute(outDir) || win32.isAbsolute(outDir)) {
    throw escapes('outDir', outDir);
  }
  if (isAbsolute(entry.source.file) || win32.isAbsolute(entry.source.file)) {
    throw escapes('source file', entry.source.file);
  }

  const file = entry.source.file.split('/').join(sep);
  let inside = file;
  if (file.startsWith(`src${sep}`)) {
    inside = file.slice(4);
  } else if (file.startsWith(`${outDir}${sep}`)) {
    inside = relative(outDir, file);
  }

  const result = resolve(root, outDir, inside.replace(/\.[mc]?ts$/, '.js'));
  const found = existsSync(result);
  const rel = relative(found ? realpathSync(root) : resolve(root), found ? realpathSync(result) : result);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw escapes('path', result);
  }
  return result;
}
