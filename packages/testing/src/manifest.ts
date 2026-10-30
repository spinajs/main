import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { hashManifest, MANIFEST_TOKEN, MANIFEST_VERSION } from '@spinajs/manifest';
import type { Manifest, ManifestMode, SourceRef } from '@spinajs/manifest';
import { MANIFEST_SETTINGS, registerManifest, registerManifestSettings } from '@spinajs/configuration';

export function sourceRef(file: string, pkg = 'test-app'): SourceRef {
  return { file, line: 1, col: 1, package: pkg };
}

/** A valid, empty v1 manifest for unit tests; `root` becomes `app.root`, against which `app.outDir` (`test`) is resolved. */
export function testManifest(overrides: Partial<Manifest> & { root?: string } = {}): Manifest {
  const { root, ...rest } = overrides;
  const manifest: Manifest = {
    manifestVersion: MANIFEST_VERSION,
    app: { name: 'test-app', version: '0.0.0', root: root ?? process.cwd(), outDir: 'test' },
    packages: [],
    generatedAt: '1970-01-01T00:00:00.000Z',
    hash: '',
    services: [],
    values: [],
    controllers: [],
    socketControllers: [],
    socketContracts: [],
    configModules: [],
    configUsages: [],
    models: [],
    migrations: [],
    schedules: [],
    commands: [],
    queueMessages: [],
    schemas: {},
    diagnostics: [],
    ...rest,
  };
  manifest.hash = hashManifest(manifest);
  return manifest;
}

/**
 * `TestAppOptions.register` helper that makes `manifest` the app's runtime manifest with `mode` as the effective
 * `system.manifest.mode`, as `ManifestConfigurationSource` would. Decorators such as `ListFromFiles` look both up from
 * the root container, so a child app registers them there too until it is disposed.
 */
export function withManifest(manifest: Manifest, mode: ManifestMode = 'prefer'): (container: IContainer) => void {
  const settings = { mode, path: 'app.manifest.json' };
  return (container) => {
    registerManifest(container, manifest);
    registerManifestSettings(container, settings);
    if (container !== DI.RootContainer) {
      registerManifest(DI.RootContainer, manifest);
      registerManifestSettings(DI.RootContainer, settings);
      container.once('di.dispose', () => {
        DI.RootContainer.uncache(MANIFEST_TOKEN);
        DI.RootContainer.uncache(MANIFEST_SETTINGS.key);
      });
    }
  };
}
