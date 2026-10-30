import { Autoinject, Container, IContainer, Injectable } from '@spinajs/di';
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';
import { InternalLogger } from '@spinajs/internal-logger';
import { loadRuntimeManifest, type ManifestMode } from '@spinajs/manifest';
import { MANIFEST, registerManifest } from './manifest-runtime.js';

const MANIFEST_KEYS: ReadonlySet<string> = new Set(['path', 'mode']);

/**
 * Registers the runtime manifest before every file source runs ( Order 0 ). The file sources then take the package
 * config files from it instead of globbing `node_modules/@spinajs/<pkg>/lib/config`; loading and merging stay theirs.
 * It reads `system.manifest` from the configuration merged so far; `SPINAJS_MANIFEST` and `SPINAJS_MANIFEST_MODE` win over it.
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

  public Load(config: Configuration): Promise<IConfigLike> {
    const section = config.get<Record<string, unknown> | undefined>('system.manifest', undefined);
    this.warnUnknownKeys(section);

    const mode = config.get<string | undefined>('process.env.SPINAJS_MANIFEST_MODE', undefined) ?? (section?.mode as string | undefined) ?? 'off';
    const path = config.get<string | undefined>('process.env.SPINAJS_MANIFEST', undefined) ?? (section?.path as string | undefined) ?? 'app.manifest.json';

    // loadRuntimeManifest rejects an unknown mode, so a typo in the env var cannot silently turn the manifest off.
    const manifest = loadRuntimeManifest({ path, mode: mode as ManifestMode }, process.cwd());
    if (!manifest) {
      this.Container.uncache(MANIFEST.key);
      return Promise.resolve({});
    }

    registerManifest(this.Container, manifest);
    InternalLogger.info({ path, mode, hash: manifest.hash.slice(0, 12) }, 'Manifest ${path} loaded ( ${mode}, ${hash} )', 'Configuration');
    return Promise.resolve({});
  }

  private warnUnknownKeys(section: Record<string, unknown> | undefined): void {
    const unknown = Object.keys(section ?? {}).filter((k) => !MANIFEST_KEYS.has(k));
    if (unknown.length > 0) {
      InternalLogger.warn({ keys: unknown.join(', ') }, 'Unknown system.manifest keys ${keys} are ignored; allowed: path, mode', 'Configuration');
    }
  }
}
