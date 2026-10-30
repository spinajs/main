import { existsSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import glob from 'glob';
import minimatch from 'minimatch';
import { PROPERTY_TYPE_RESOLVER, token } from '@spinajs/di';
import { InternalLogger } from '@spinajs/internal-logger';
import type { Class, IContainer, IPropertyTypeResolver } from '@spinajs/di';
import { appRootOf, isPackageSkipped, manifestFileFor, ManifestMissing, MANIFEST_TOKEN, resolvedTypeRef, resolveTypeRef, type Manifest, type ManifestMode, type RuntimeTypeRef } from '@spinajs/manifest';

/** Typed key of the runtime manifest; same string key as MANIFEST_TOKEN. */
export const MANIFEST = token<Manifest>(MANIFEST_TOKEN, 'runtime manifest');

export function registerManifest(container: IContainer, manifest: Manifest): void {
  container.register(manifest).asValue(MANIFEST.key, true);
}

/** The manifest of the nearest container in the lineage that registered one. */
export function manifestOf(container: IContainer): Manifest | undefined {
  let current: IContainer | undefined = container;
  while (current) {
    const found = current.get(MANIFEST, false);
    if (found) return found;
    current = current.Parent;
  }
  return undefined;
}

/** The `system.manifest` in effect: decided once per configuration load, before any package config file loads. */
export interface ManifestSettings {
  mode: ManifestMode;
  path: string;
}

export const MANIFEST_SETTINGS = token<ManifestSettings>(`${MANIFEST_TOKEN}.settings`, 'effective system.manifest');

export function registerManifestSettings(container: IContainer, settings: ManifestSettings): void {
  container.register(settings).asValue(MANIFEST_SETTINGS.key, true);
  container.register(manifestPropertyTypes).asValue(PROPERTY_TYPE_RESOLVER.key, true);
}

const PROPERTY_TYPE_REFS = new WeakMap<Manifest, Map<string, RuntimeTypeRef>>();

function propertyTypeRefOf(manifest: Manifest, owner: string, property: string): RuntimeTypeRef | undefined {
  let refs = PROPERTY_TYPE_REFS.get(manifest);
  if (!refs) {
    refs = new Map();
    for (const entry of [...manifest.services, ...manifest.controllers, ...manifest.socketControllers]) {
      for (const inject of entry.propertyInjects ?? []) {
        const key = `${entry.className}.${inject.property}`;
        if (inject.tokenRef && !refs.has(key)) refs.set(key, inject.tokenRef);
      }
    }
    PROPERTY_TYPE_REFS.set(manifest, refs);
  }
  return refs.get(`${owner}.${property}`);
}

/** Types `@Autoinject()` / `@LazyInject()` properties of a build without decorator metadata from `propertyInjects[].tokenRef`. */
const manifestPropertyTypes: IPropertyTypeResolver = {
  typeOf(owner, property, container) {
    const manifest = effectiveManifestOf(container)?.manifest;
    const ref = manifest && propertyTypeRefOf(manifest, owner.name, property);
    if (!manifest || !ref) return undefined;
    return (resolvedTypeRef(ref, manifest) as Class<unknown> | undefined) ?? (resolveTypeRef(ref, manifest) as Promise<Class<unknown>>);
  },
};

/** The effective `system.manifest` of the nearest container in the lineage that decided one. */
export function manifestSettingsOf(container: IContainer): ManifestSettings | undefined {
  let current: IContainer | undefined = container;
  while (current) {
    const found = current.get(MANIFEST_SETTINGS, false);
    if (found) return found;
    current = current.Parent;
  }
  return undefined;
}

export interface EffectiveManifest {
  settings: ManifestSettings;
  /** `undefined` for `off`, and for `prefer` without a manifest */
  manifest: Manifest | undefined;
}

/**
 * The switch decided in the container lineage ( `ManifestConfigurationSource`, `withManifest` ) and the manifest
 * registered with it; `undefined` when nothing decided one, i.e. an app built without the configuration source.
 */
export function effectiveManifestOf(container: IContainer): EffectiveManifest | undefined {
  const settings = manifestSettingsOf(container);
  if (!settings) return undefined;

  const manifest = settings.mode === 'off' ? undefined : manifestOf(container);
  if (settings.mode === 'require' && !manifest) {
    throw new ManifestMissing(`system.manifest.mode is 'require' but no manifest is registered for ${settings.path}`);
  }
  return { settings, manifest };
}

/** The manifest to read from instead of scanning: registered, and the effective mode is not `off`. */
export function activeManifestOf(container: IContainer): Manifest | undefined {
  const mode = manifestSettingsOf(container)?.mode ?? 'off';
  return mode === 'off' ? undefined : manifestOf(container);
}

/** The app's own config dirs, in merge order; package config files merge between the two lists. */
export interface ProjectConfigDirs {
  beforePackages: string[];
  afterPackages: string[];
}

export function projectConfigDirs(cwd: string, runApp?: string, appBaseDir?: string, customPaths?: string[]): ProjectConfigDirs {
  const root = resolve(cwd);
  const afterPackages = ['lib/config', 'dist/config', 'build/config', 'config'].map((d) => normalize(join(root, d)));

  if (runApp) {
    if (appBaseDir) {
      afterPackages.push(join(appBaseDir, `/${runApp}/config`));
    }
    for (const prefix of ['', '/dist', '/lib', '/build']) {
      afterPackages.push(join(cwd, `${prefix}/apps/${runApp}/config`));
    }
  }

  if (customPaths) {
    afterPackages.push(...customPaths);
  }

  return { beforePackages: [normalize(join(root, 'src', '/config'))], afterPackages };
}

/** Without a manifest only this scope is globbed ( `node_modules/@spinajs/*` ), so only it is loaded with one. */
const PACKAGE_SCOPE = '@spinajs/';

interface ListedConfigFile {
  level: number;
  // `<package>/<outDir>/config/...`: within one level, sorting by it gives the order the glob over node_modules/@spinajs gives
  order: string;
  file: string;
}

/** Steps from the app root up to the directory whose node_modules holds `name`, as node resolves it. */
function installLevel(name: string, appRoot: string): number {
  for (let dir = appRoot, level = 0; ; dir = dirname(dir), level++) {
    if (existsSync(join(dir, 'node_modules', name))) return level;
    if (dirname(dir) === dir) return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Config files of the manifest packages that match `pattern` ( a file-source pattern such as `!(*.*).{cjs,js}` ),
 * in the order the walk lists them: the `node_modules/@spinajs/*\/lib/config/**` glob of the nearest level first.
 * Every file goes through `manifestFileFor`, which keeps it inside its package root. A listed package that is not installed is skipped.
 */
export function manifestPackageConfigFiles(manifest: Manifest, pattern: string, cwd: string, mode: ManifestMode = 'prefer'): string[] {
  const listed: ListedConfigFile[] = [];
  const appRoot = appRootOf(manifest, cwd);

  for (const pkg of manifest.packages) {
    if (!pkg.name.startsWith(PACKAGE_SCOPE)) continue;
    if (isPackageSkipped(pkg.name, manifest, cwd, mode)) {
      InternalLogger.debug({ name: pkg.name }, 'Package ${name} is listed in the manifest but not installed, its config is skipped', 'Configuration');
      continue;
    }
    const level = installLevel(pkg.name, appRoot);

    const resolveFile = (file: string) => manifestFileFor({ source: { file: `${pkg.outDir}/${file}`, line: 1, col: 1, package: pkg.name } }, manifest, cwd);
    const files = pkg.configFiles ?? builtConfigFiles(resolveFile('config'), pattern);

    for (const file of files) {
      if (!file.startsWith('config/') || !minimatch(file.slice('config/'.length), `**/${pattern}`)) continue;
      const resolved = resolveFile(file);
      if (existsSync(resolved)) {
        listed.push({ level, order: `${pkg.name}/${pkg.outDir}/${file}`, file: resolved });
      }
    }
  }

  // glob sorts its results with localeCompare( 'en' )
  return listed.sort((a, b) => a.level - b.level || a.order.localeCompare(b.order, 'en')).map((l) => l.file);
}

// A fragment older than `configFiles`: its one config dir is globbed, as without a manifest.
function builtConfigFiles(configDir: string, pattern: string): string[] {
  return glob.sync(`**/${pattern}`, { cwd: configDir }).map((f) => `config/${relative(configDir, join(configDir, f)).split(sep).join('/')}`);
}
