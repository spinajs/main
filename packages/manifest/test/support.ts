import type { Condition, ControllerEntry, Manifest, ManifestFragment, ParamEntry, RouteEntry, ServiceEntry, SourceRef } from '../src/index.js';

export const src = (pkg = 'app'): SourceRef => ({ file: 'src/x.ts', line: 1, col: 1, package: pkg });

export function fragment(name: string, over: Partial<ManifestFragment> = {}): ManifestFragment {
  return {
    manifestVersion: 2,
    package: { name, version: '1.0.0', entry: 'lib/index.js', outDir: 'lib' },
    services: [], values: [], controllers: [], socketControllers: [], socketContracts: [],
    configModules: [], configUsages: [], models: [], migrations: [], schedules: [], commands: [], queueMessages: [],
    schemas: {}, diagnostics: [],
    ...over,
  };
}

export function service(pkg: string, className: string, registeredAs: string[] = [className]): ServiceEntry {
  return { id: className, className, registeredAs, lifetime: 'singleton', async: false, bootstrapper: false, ctorInjects: [], propertyInjects: [], source: src(pkg) };
}

export function route(path: string, fullPath = ''): RouteEntry {
  return { method: 'get', path, handler: 'h', fullPath, params: [], returnType: { text: 'void' }, policies: [], middlewares: [], source: src('p') };
}

export function controller(pkg: string, className: string, basePath: string | null, routes: RouteEntry[]): ControllerEntry {
  return { id: className, className, basePath, policies: [], middlewares: [], routes, source: src(pkg) };
}

export function routeEntry(method: RouteEntry['method'], fullPath: string, extra: Partial<RouteEntry> = {}): RouteEntry {
  return { method, path: fullPath.split('/').slice(2).join('/'), handler: method, fullPath, params: [], returnType: { text: 'void' }, policies: [], middlewares: [], source: src(), ...extra };
}

export function controllerEntry(partial: Partial<ControllerEntry> & Pick<ControllerEntry, 'className'>): ControllerEntry {
  return { id: `app:${partial.className}`, basePath: null, policies: [], middlewares: [], routes: [], source: src(), ...partial };
}

export function manifestWith(over: Partial<Manifest> = {}): Manifest {
  return {
    manifestVersion: 2,
    app: { name: 'app', version: '1.0.0', root: '.', outDir: 'lib' },
    packages: [], services: [], values: [], controllers: [], socketControllers: [], socketContracts: [],
    configModules: [], configUsages: [], models: [], migrations: [], schedules: [], commands: [], queueMessages: [],
    schemas: {}, diagnostics: [], generatedAt: '2026-01-01T00:00:00.000Z', hash: '0'.repeat(64),
    ...over,
  };
}

export const bodyParam = (text: string, schema: string): ParamEntry => ({ index: 0, name: 'body', kind: 'FromBody', runtimeType: { text, schema }, required: true, wire: { in: 'body', shape: 'whole' } });

export const withSchema = (m: Manifest, id: string, schema: unknown): Manifest => ({ ...m, schemas: { ...m.schemas, [id]: schema } });

/** The documented override: `AppProfilesController extends ProfilesController`, no own `@BasePath`, registered over the base. */
export const profilesOverride = {
  base: controllerEntry({ id: '@x/users:ProfilesController', className: 'ProfilesController', basePath: 'profiles', routes: [routeEntry('get', '/profiles/:id')] }),
  sub: controllerEntry({ id: 'app:AppProfilesController', className: 'AppProfilesController', basePath: 'profiles', bases: ['@x/users:ProfilesController'], routes: [routeEntry('get', '/profiles/:id', { inheritedFrom: '@x/users:ProfilesController' })] }),
  registration: (condition?: Condition): ServiceEntry => ({ id: 'app:AppProfilesController', className: 'AppProfilesController', registeredAs: ['ProfilesController'], lifetime: 'singleton', async: false, bootstrapper: false, ctorInjects: [], propertyInjects: [], ...(condition ? { condition } : {}), source: src() }),
};
