import { DI, PROPERTY_TYPE_RESOLVER } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { hashManifest, MANIFEST_TOKEN, MANIFEST_VERSION } from '@spinajs/manifest';
import type { Manifest, ManifestMode, SourceRef } from '@spinajs/manifest';
import { MANIFEST_PROPERTY_TYPES, MANIFEST_SETTINGS, registerManifest, registerManifestSettings } from '@spinajs/configuration';

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

// How many live child apps added each value to root: two apps may share one manifest object.
const rootHolds = new Map<object, number>();

function holdInRoot(key: string, value: object): void {
  rootHolds.set(value, (rootHolds.get(value) ?? 0) + 1);
  DI.RootContainer.register(value).asValue(key);
}

function releaseFromRoot(key: string, value: object): void {
  const left = (rootHolds.get(value) ?? 1) - 1;
  if (left > 0) {
    rootHolds.set(value, left);
    return;
  }
  rootHolds.delete(value);
  const values = DI.RootContainer.Registry.getValues(key);
  const index = values?.indexOf(value) ?? -1;
  if (values && index !== -1) {
    values.splice(index, 1);
    if (values.length === 0) DI.RootContainer.Registry.removeValue(key);
  }
}

/**
 * `TestAppOptions.register` helper that makes `manifest` the app's runtime manifest with `mode` as the effective
 * `system.manifest.mode`, as `ManifestConfigurationSource` would. Decorators such as `ListFromFiles` look them up from
 * the root container, and a service registered in root resolves there, so a child app adds them to root too until it
 * is disposed; what root held before stays.
 */
export function withManifest(manifest: Manifest, mode: ManifestMode = 'prefer'): (container: IContainer) => void {
  return (container) => {
    const settings = { mode, path: 'app.manifest.json' };
    registerManifest(container, manifest);
    registerManifestSettings(container, settings);
    if (container === DI.RootContainer) return;

    holdInRoot(MANIFEST_TOKEN, manifest);
    holdInRoot(MANIFEST_SETTINGS.key, settings);
    holdInRoot(PROPERTY_TYPE_RESOLVER.key, MANIFEST_PROPERTY_TYPES);
    container.once('di.dispose', () => {
      releaseFromRoot(MANIFEST_TOKEN, manifest);
      releaseFromRoot(MANIFEST_SETTINGS.key, settings);
      releaseFromRoot(PROPERTY_TYPE_RESOLVER.key, MANIFEST_PROPERTY_TYPES);
    });
  };
}
