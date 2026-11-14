import { MANIFEST_VERSION, type Manifest } from '@spinajs/manifest';

/** A manifest holding only `schemas`, each under its id. */
export function manifestOf(schemas: Record<string, object>): Manifest {
  return {
    manifestVersion: MANIFEST_VERSION,
    app: { name: 'test-app', version: '0.0.0', root: process.cwd(), outDir: 'lib' },
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
    schemas: Object.fromEntries(Object.entries(schemas).map(([id, schema]) => [id, { $id: id, ...schema }])),
    schedules: [],
    commands: [],
    queueMessages: [],
    diagnostics: [],
  };
}
