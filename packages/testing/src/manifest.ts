import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { hashManifest, MANIFEST_TOKEN, MANIFEST_VERSION } from '@spinajs/manifest';
import type { Manifest, SourceRef } from '@spinajs/manifest';

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
 * `TestAppOptions.register` helper that makes `manifest` visible to the app. Decorators such as `ListFromFiles`
 * look it up from the root container, so a child app registers it there too until it is disposed.
 */
export function withManifest(manifest: Manifest): (container: IContainer) => void {
  return (container) => {
    container.register(manifest).asValue(MANIFEST_TOKEN);
    if (container !== DI.RootContainer) {
      DI.RootContainer.register(manifest).asValue(MANIFEST_TOKEN);
      container.once('di.dispose', () => {
        DI.RootContainer.unregister(MANIFEST_TOKEN);
        DI.RootContainer.uncache(MANIFEST_TOKEN);
      });
    }
  };
}
