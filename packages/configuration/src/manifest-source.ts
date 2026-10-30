import { dirname, posix } from 'node:path';
import { existsSync } from 'node:fs';
import { Autoinject, Container, IContainer, Injectable, token } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike, normalizeEnvironment } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { loadRuntimeManifest, manifestFileFor, MANIFEST_TOKEN, packageRootOf, type Manifest, type ManifestMode } from '@spinajs/manifest';
import _ from 'lodash';
import { loadJsConfigFile, mergeArrays } from './util.js';

/** Typed key of the runtime manifest; same string key as MANIFEST_TOKEN. */
export const MANIFEST = token<Manifest>(MANIFEST_TOKEN, 'runtime manifest');

const MANIFEST_KEYS: ReadonlySet<string> = new Set(['path', 'mode']);

export function registerManifest(container: IContainer, manifest: Manifest): void {
  container.register(manifest).asValue(MANIFEST.key);
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

/**
 * Loads package configuration defaults from the files the manifest lists, instead of globbing
 * `node_modules/@spinajs/<pkg>/lib/config`. Runs before every file source ( Order 0 ), so they see the
 * registered manifest and skip their package walk. It reads `system.manifest` from the configuration merged
 * so far ( defaults, and whatever an earlier layer set ); `SPINAJS_MANIFEST` and `SPINAJS_MANIFEST_MODE`
 * win over it. Values from config files are merged later and cannot reach this source.
 */
@Injectable(ConfigurationSource)
export class ManifestConfigurationSource extends ConfigurationSource {
  @Autoinject(Container)
  protected Container!: IContainer;

  // ConfigurationSource implementations receive ( RunApp, CustomConfigPaths, appBaseDir, Env )
  constructor(_runApp?: string, _customConfigPaths?: string[], _appBaseDir?: string, protected Env?: string) {
    super();
  }

  public get Order(): number {
    return 0;
  }

  public async Load(config: Configuration): Promise<IConfigLike> {
    const section = config.get<Record<string, unknown> | undefined>('system.manifest', undefined);
    this.warnUnknownKeys(section);

    const mode = config.get<string | undefined>('process.env.SPINAJS_MANIFEST_MODE', undefined) ?? (section?.mode as string | undefined) ?? 'off';
    const path = config.get<string | undefined>('process.env.SPINAJS_MANIFEST', undefined) ?? (section?.path as string | undefined) ?? 'app.manifest.json';

    // loadRuntimeManifest rejects an unknown mode, so a typo in the env var cannot silently turn the manifest off.
    const manifest = loadRuntimeManifest({ path, mode: mode as ManifestMode }, process.cwd());
    if (!manifest) {
      return {};
    }

    registerManifest(this.Container, manifest);
    InternalLogger.info({ path, mode, hash: manifest.hash.slice(0, 12) }, 'Manifest ${path} loaded ( ${mode}, ${hash} )', 'Configuration');
    this.deriveWorkspaceRoot(manifest);

    const appEnv = normalizeEnvironment(config.get<string | undefined>('process.env.APP_ENV', undefined) ?? this.Env);
    const merged: IConfigLike = {};

    for (const module of manifest.configModules) {
      if (!module.defaultsFile) continue;

      const ext = posix.extname(module.defaultsFile);
      const envFile = posix.join(posix.dirname(module.defaultsFile), `${posix.basename(module.defaultsFile, ext)}.${appEnv}${ext}`);

      // Both files go through manifestFileFor: containment and outDir mapping are enforced there.
      for (const file of [module.defaultsFile, envFile]) {
        const resolved = manifestFileFor({ source: { ...module.source, file } }, manifest, process.cwd());
        if (!existsSync(resolved)) continue;
        const loaded = await loadJsConfigFile(resolved);
        _.mergeWith(merged, loaded.default ?? loaded, mergeArrays);
      }
    }

    return merged;
  }

  private warnUnknownKeys(section: Record<string, unknown> | undefined): void {
    const unknown = Object.keys(section ?? {}).filter((k) => !MANIFEST_KEYS.has(k));
    if (unknown.length > 0) {
      InternalLogger.warn({ keys: unknown.join(', ') }, 'Unknown system.manifest keys ${keys} are ignored; allowed: path, mode', 'Configuration');
    }
  }

  /**
   * Package configs build asset paths from WORKSPACE_ROOT_PATH. For a package installed under
   * `<root>/node_modules/@spinajs/<name>` the root follows from the manifest without walking directories;
   * a linked workspace package resolves outside node_modules and keeps the file sources' detection.
   */
  private deriveWorkspaceRoot(manifest: Manifest): void {
    if (process.env.WORKSPACE_ROOT_PATH) return;

    for (const pkg of manifest.packages) {
      if (!pkg.name.startsWith('@spinajs/')) continue;

      const scope = dirname(packageRootOf(pkg.name, manifest, process.cwd()));
      const nodeModules = dirname(scope);
      if (posix.basename(scope.replace(/\\/g, '/')) === '@spinajs' && posix.basename(nodeModules.replace(/\\/g, '/')) === 'node_modules') {
        process.env.WORKSPACE_ROOT_PATH = dirname(nodeModules);
        return;
      }
    }
  }
}
