import * as fs from 'node:fs';
import * as path from 'node:path';
import glob from 'glob';
import { Autoinject, Container, DI, IContainer, Injectable } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike, normalizeEnvironment } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { loadRuntimeManifest, type ManifestMode } from '@spinajs/manifest';
import { MANIFEST, projectConfigDirs, registerManifest, registerManifestSettings, type ManifestSettings } from './manifest-runtime.js';
import { findBasePath } from './util.js';
import { BaseFileSource } from './sources.js';

const MANIFEST_KEYS: ReadonlySet<string> = new Set(['path', 'mode']);

type ManifestSection = Partial<Record<string, unknown>>;
type WithManifest = { system?: { manifest?: ManifestSection } };

/**
 * Decides the effective `system.manifest` once, before any package config file loads ( Order 0 ):
 * `SPINAJS_MANIFEST` / `SPINAJS_MANIFEST_MODE` win, then `system.manifest` from the app's own config dirs ( read here,
 * without the node_modules walk ), then the defaults merged so far. It registers that value under `MANIFEST_SETTINGS`,
 * and the loaded manifest under `MANIFEST`, for the file sources, reflection, http and orm to read; the final
 * configuration's `system.manifest` is set to it as well.
 */
@Injectable(ConfigurationSource)
export class ManifestConfigurationSource extends ConfigurationSource {
  @Autoinject(Container)
  protected Container!: IContainer;

  // ConfigurationSource implementations receive ( RunApp, CustomConfigPaths, appBaseDir, Env )
  constructor(
    protected RunApp?: string,
    protected CustomConfigPaths?: string[],
    protected appBaseDir?: string,
    protected Env?: string,
  ) {
    super();
  }

  public get Order(): number {
    return 0;
  }

  public async Load(config: Configuration): Promise<IConfigLike> {
    // The app config files read below, and package configs later, build paths from it when they are imported.
    BaseFileSource.ensureWorkspaceRoot();
    const settings = await this.effectiveSettings(config);

    // loadRuntimeManifest rejects an unknown mode, so a typo cannot silently turn the manifest off.
    const manifest = loadRuntimeManifest(settings, process.cwd());
    registerManifestSettings(this.Container, settings);

    if (manifest) {
      registerManifest(this.Container, manifest);
      InternalLogger.info({ ...settings, hash: manifest.hash.slice(0, 12) }, 'Manifest ${path} loaded ( ${mode}, ${hash} )', 'Configuration');
    } else {
      this.Container.uncache(MANIFEST.key);
    }

    return { system: { manifest: { ...settings } } };
  }

  protected async effectiveSettings(config: Configuration): Promise<ManifestSettings> {
    const project = await this.projectSection(normalizeEnvironment(config.get<string | undefined>('process.env.APP_ENV', undefined) ?? this.Env));
    this.warnUnknownKeys(project);
    const defaults = config.get<ManifestSection | undefined>('system.manifest', undefined) ?? {};

    const pick = (envKey: string, key: string, fallback: string): string =>
      config.get<string | undefined>(`process.env.${envKey}`, undefined) ?? (project[key] as string | undefined) ?? (defaults[key] as string | undefined) ?? fallback;

    return { mode: pick('SPINAJS_MANIFEST_MODE', 'mode', 'off') as ManifestMode, path: pick('SPINAJS_MANIFEST', 'path', 'app.manifest.json') };
  }

  /**
   * `system.manifest` merged from the app's own config files, in the order the file sources merge them. A JS file is
   * imported without its `onConfigLoad` hook; the file sources import the same module again from the ESM cache.
   */
  protected async projectSection(appEnv: string): Promise<ManifestSection> {
    const dirs = projectConfigDirs(process.cwd(), this.RunApp, this.appBaseDir, this.CustomConfigPaths);
    const basePath = findBasePath(process.cwd()) ?? process.cwd();
    const absolute = [...dirs.beforePackages, ...dirs.afterPackages].map((d) => (path.isAbsolute(d) ? d : path.join(basePath, d)));
    const merged: ManifestSection = {};

    for (const pattern of ['!(*.*).{cjs,js}', `*.${appEnv}.{cjs,js}`, '!(*.*).json', `*.${appEnv}.json`]) {
      for (const file of absolute.flatMap((d) => glob.sync(path.join(d, `/**/${pattern}`).replace(/\\/g, '/')))) {
        Object.assign(merged, await manifestSectionOf(file));
      }
    }

    return merged;
  }

  private warnUnknownKeys(section: ManifestSection): void {
    const unknown = Object.keys(section).filter((k) => !MANIFEST_KEYS.has(k));
    if (unknown.length > 0) {
      InternalLogger.warn({ keys: unknown.join(', ') }, 'Unknown system.manifest keys ${keys} are ignored; allowed: path, mode', 'Configuration');
    }
  }
}

async function manifestSectionOf(file: string): Promise<ManifestSection | undefined> {
  try {
    const loaded = (file.endsWith('.json') ? JSON.parse(fs.readFileSync(file, 'utf-8')) : await DI.__spinajs_require__(file)) as (WithManifest & { default?: WithManifest }) | undefined;
    return (loaded?.default ?? loaded)?.system?.manifest;
  } catch {
    // the file sources load it again and report the error
    return undefined;
  }
}
