import { hashManifest, MANIFEST_VERSION } from '@spinajs/manifest';
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
