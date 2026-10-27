import type { ControllerEntry, ManifestFragment, RouteEntry, ServiceEntry, SourceRef } from '../src/index.js';

export const src = (pkg: string): SourceRef => ({ file: 'src/x.ts', line: 1, col: 1, package: pkg });

export function fragment(name: string, over: Partial<ManifestFragment> = {}): ManifestFragment {
  return {
    manifestVersion: 1,
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
