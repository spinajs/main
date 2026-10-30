import { existsSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import glob from 'glob';
import minimatch from 'minimatch';
import { PROPERTY_TYPE_RESOLVER, ResolveException, token } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { InternalLogger } from '@spinajs/internal-logger';
import type { Class, IContainer, IPropertyTypeResolver } from '@spinajs/di';
import { appRootOf, isPackageSkipped, manifestFileFor, ManifestMissing, MANIFEST_TOKEN, resolvedTypeRef, resolveTypeRef, type Manifest, type ManifestMode, type PropertyInject } from '@spinajs/manifest';

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
  container.register(MANIFEST_PROPERTY_TYPES).asValue(PROPERTY_TYPE_RESOLVER.key, true);
}

const CLASS_PROPERTIES = new WeakMap<Manifest, Map<string, PropertyInject[]>>();

/** The runtime knows a class by name alone: every entry of that name that declares the property, in any package. */
function declarationsOf(manifest: Manifest, owner: string, property: string): PropertyInject[] {
  let table = CLASS_PROPERTIES.get(manifest);
  if (!table) {
    table = new Map();
    for (const entry of manifest.classProperties ?? []) {
      for (const declared of entry.properties) {
        const key = `${entry.className}.${declared.property}`;
        table.set(key, [...(table.get(key) ?? []), declared]);
      }
    }
    CLASS_PROPERTIES.set(manifest, table);
  }
  return table.get(`${owner}.${property}`) ?? [];
}

const sameDeclaration = (a: PropertyInject, b: PropertyInject): boolean => a.array === b.array && JSON.stringify(a.tokenRef) === JSON.stringify(b.tokenRef);

/** Answers from `manifest.classProperties`, which only a build without decorator metadata has. */
export const MANIFEST_PROPERTY_TYPES: IPropertyTypeResolver = {
  typeOf(owner, property, container) {
    const effective = effectiveManifestOf(container);
    if (!effective?.manifest) return undefined;

    const [declared, ...others] = declarationsOf(effective.manifest, owner.name, property);
    if (!declared) {
      if (effective.settings.mode === 'require') {
        throw new ResolveException(`cannot inject ${owner.name}.${property}: the build emits no decorator metadata and the manifest does not list the property; rebuild it ( spinajs build ) from a tsconfig with emitDecoratorMetadata off`);
      }
      return undefined;
    }
    if (others.some((other) => !sameDeclaration(declared, other))) {
      throw new ResolveException(`cannot inject ${owner.name}.${property}: the manifest lists more than one class ${owner.name} and they declare it differently; rename one, or pass the type to the decorator`);
    }
    const type = declared.tokenRef && (resolvedTypeRef(declared.tokenRef, effective.manifest) as Class<unknown> | undefined);
    return { type, array: declared.array };
  },
};

/**
 * Imports every class `manifest.classProperties` names, so that `MANIFEST_PROPERTY_TYPES` answers synchronously and
 * the first resolve of a sync service stays sync. A class that cannot load fails the boot in `require`; in `prefer`
 * it is logged, and resolving its owner throws `ResolveException`.
 */
export async function preloadPropertyTypes(container: IContainer): Promise<void> {
  const manifest = activeManifestOf(container);
  for (const entry of manifest?.classProperties ?? []) {
    for (const { property, tokenRef } of entry.properties) {
      if (!tokenRef) continue;
      try {
        await resolveTypeRef(tokenRef, manifest!);
      } catch (err) {
        const problem = `cannot load the type of ${entry.id}.${property}: ${(err as Error).message}`;
        if (manifestSettingsOf(container)?.mode === 'require') {
          throw new InvalidOperation(problem);
        }
        InternalLogger.warn({ problem }, 'Manifest property types: ${problem}', 'Configuration');
      }
    }
  }
}

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
