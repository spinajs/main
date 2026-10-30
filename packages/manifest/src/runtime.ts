import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readManifestObject } from './read.js';
import type { Manifest, SourceRef } from './types.js';

/** DI key the runtime manifest is registered under. */
export const MANIFEST_TOKEN = '__manifest__';

export type ManifestMode = 'off' | 'prefer' | 'require';

export interface ManifestRuntimeOptions {
  path: string;
  mode: ManifestMode;
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

  return readManifestObject(JSON.parse(readFileSync(file, 'utf8')), file);
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
    return entry.slice(0, entry.length - listed.entry.length - 1);
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

  const file = entry.source.file.split('/').join(sep);
  let inside = file;
  if (file.startsWith(`src${sep}`)) {
    inside = file.slice(4);
  } else if (file.startsWith(`${outDir}${sep}`)) {
    inside = relative(outDir, file);
  }

  return resolve(root, outDir, inside.replace(/\.[mc]?ts$/, '.js'));
}
