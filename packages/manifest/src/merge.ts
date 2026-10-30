import { canonicalize, hashManifest } from './hash.js';
import { MANIFEST_VERSION } from './types.js';
import type { Diagnostic, Manifest, ManifestFragment } from './types.js';

export interface MergeMeta {
  app: Manifest['app'];
  packages: Manifest['packages'];
  generatedAt?: string;
}

const prefixId = (pkg: string, id: string): string => (id.startsWith(`${pkg}:`) ? id : `${pkg}:${id}`);

/** Dependencies come first so that, with "last wins" at runtime, the app overrides its packages. */
export function mergeFragments(app: ManifestFragment, deps: ManifestFragment[], meta: MergeMeta): Manifest {
  const fragments = [...deps, app];
  const diagnostics: Diagnostic[] = [];
  const schemas: Record<string, unknown> = {};
  const schemaOwner = new Map<string, string>();
  const registrations = new Map<string, { pkg: string; id: string }>();

  const withIds = <T extends { id: string }>(pkg: string, items: T[]): T[] => items.map((i) => ({ ...i, id: prefixId(pkg, i.id) }));
  const collect = <T extends { id: string }>(pick: (f: ManifestFragment) => T[]): T[] => fragments.flatMap((f) => withIds(f.package.name, pick(f)));
  const plain = <T>(pick: (f: ManifestFragment) => T[]): T[] => fragments.flatMap(pick);

  for (const f of fragments) {
    const pkg = f.package.name;
    diagnostics.push(...f.diagnostics);

    for (const [id, schema] of Object.entries(f.schemas)) {
      if (!(id in schemas)) {
        schemas[id] = schema;
        schemaOwner.set(id, pkg);
      } else if (canonicalize(schemas[id]) !== canonicalize(schema)) {
        diagnostics.push({ code: 'schema-id-collision', severity: 'error', message: `Schema $id "${id}" is defined differently in "${schemaOwner.get(id)}" and "${pkg}"` });
      }
    }

    for (const s of f.services) {
      for (const key of s.registeredAs) {
        const previous = registrations.get(key);
        if (previous && previous.pkg !== pkg) {
          diagnostics.push({ code: 'duplicate-registration', severity: 'info', message: `DI key "${key}" is registered by "${previous.pkg}" (${previous.id}) and "${pkg}" (${s.id}); the last one wins`, source: s.source });
        }
        registrations.set(key, { pkg, id: s.id });
      }
    }
  }

  const manifest: Manifest = {
    manifestVersion: MANIFEST_VERSION,
    app: meta.app,
    packages: meta.packages,
    services: collect((f) => f.services),
    values: plain((f) => f.values),
    controllers: collect((f) => f.controllers),
    socketControllers: collect((f) => f.socketControllers),
    socketContracts: collect((f) => f.socketContracts),
    configModules: plain((f) => f.configModules),
    configUsages: plain((f) => f.configUsages),
    models: collect((f) => f.models),
    migrations: collect((f) => f.migrations),
    schedules: plain((f) => f.schedules),
    commands: plain((f) => f.commands),
    queueMessages: plain((f) => f.queueMessages),
    schemas,
    diagnostics,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    hash: '',
  };
  manifest.hash = hashManifest(manifest);
  return manifest;
}
