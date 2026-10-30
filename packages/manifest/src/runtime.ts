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

/**
 * `node_modules/<name>` of the nearest ancestor of `fromDir` that has it, as a real path. Looked up directly because
 * `require.resolve` fails for an ESM-only package whose `exports` hide package.json and have no `require` condition.
 */
function installedPackageRoot(fromDir: string, name: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate);
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

/**
 * Opt-in package locations for an app that ships without `node_modules` ( a bundle ): `SPINAJS_PACKAGE_ROOTS` names a
 * JSON file mapping a package name to its directory relative to the app root. A package that is not in the map, or
 * whose directory is missing, is located the usual way, so it is skipped or fails `require` exactly as in a normal app.
 */
function mappedPackageRoot(name: string, appRoot: string): string | undefined {
  const file = process.env.SPINAJS_PACKAGE_ROOTS;
  if (!file) {
    return undefined;
  }

  const map = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (typeof map !== 'object' || map === null || Object.values(map).some((v) => typeof v !== 'string')) {
    throw new ManifestMissing(`${file}: package-roots must be an object of package name to directory`);
  }
  const dir = map[name] as string | undefined;
  if (dir === undefined) {
    return undefined;
  }

  const root = resolve(appRoot, dir);
  const rel = relative(resolve(appRoot), root);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ManifestMissing(`package ${name}: mapped directory '${dir}' leaves the root ${appRoot}`);
  }
  if (!existsSync(root)) {
    return undefined;
  }
  const real = realpathSync(root);
  const realRel = relative(realpathSync(appRoot), real);
  if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new ManifestMissing(`package ${name}: mapped directory '${dir}' leaves the root ${appRoot}`);
  }
  return real;
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

  const appRoot = appRootOf(manifest, cwd);
  const installed = mappedPackageRoot(name, appRoot) ?? installedPackageRoot(appRoot, name);
  if (installed) {
    return installed;
  }

  const require = createRequire(join(appRoot, 'package.json'));
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
 * True for a package the manifest lists but the run-time install lacks (pruned devDependency, absent optional peer):
 * the manifest describes what may be installed, so it is skipped. In `require` mode a missing direct `dependency`
 * of the app is an error instead: the app cannot run without it.
 */
export function isPackageSkipped(name: string, manifest: Manifest, cwd: string, mode: ManifestMode): boolean {
  if (name === manifest.app.name) {
    return false;
  }
  try {
    packageRootOf(name, manifest, cwd);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') {
      throw err;
    }
  }

  if (mode === 'require' && directDependenciesOf(appRootOf(manifest, cwd)).includes(name)) {
    throw new ManifestMissing(`package ${name} is a dependency of ${manifest.app.name} and listed in the manifest, but is not installed`);
  }
  return true;
}

function directDependenciesOf(appRoot: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    return Object.keys(pkg.dependencies ?? {});
  } catch {
    return [];
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
