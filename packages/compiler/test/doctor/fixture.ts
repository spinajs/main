import type { Manifest, ServiceEntry, ControllerEntry, RouteEntry, SourceRef } from '@spinajs/manifest';

export function src(file: string, line = 1, pkg = 'app'): SourceRef {
  return { file, line, col: 1, package: pkg };
}

export function service(partial: Partial<ServiceEntry> & Pick<ServiceEntry, 'className'>): ServiceEntry {
  return {
    id: `app:${partial.className}`,
    registeredAs: [partial.className],
    lifetime: 'singleton',
    async: false,
    bootstrapper: false,
    ctorInjects: [],
    propertyInjects: [],
    source: src(`src/${partial.className}.ts`),
    ...partial,
  };
}

export function route(partial: Partial<RouteEntry> & Pick<RouteEntry, 'handler'>): RouteEntry {
  return {
    method: 'get',
    path: '',
    fullPath: `/${partial.handler}`,
    params: [],
    returnType: { text: 'void' },
    policies: [],
    middlewares: [],
    source: src('src/controller.ts'),
    ...partial,
  };
}

export function controller(partial: Partial<ControllerEntry> & Pick<ControllerEntry, 'className'>): ControllerEntry {
  return {
    id: `app:${partial.className}`,
    basePath: null,
    policies: [],
    middlewares: [],
    routes: [],
    source: src(`src/${partial.className}.ts`),
    ...partial,
  };
}

export function fixture(overrides: Partial<Manifest> = {}): Manifest {
  return {
    manifestVersion: 1,
    app: { name: 'fixture-app', version: '0.0.0', root: '/fixture', outDir: 'lib' },
    packages: [],
    generatedAt: '2026-10-27T00:00:00.000Z',
    hash: '0'.repeat(64),
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
    ...overrides,
  };
}
