import { canonicalize, hashManifest } from './hash.js';
import { MANIFEST_VERSION } from './types.js';
import type { AuthzSection, Diagnostic, Manifest, ManifestFragment, ModelEntry } from './types.js';

export interface MergeMeta {
  app: Manifest['app'];
  packages: Manifest['packages'];
  generatedAt?: string;
  buildEnv?: string;
  schemaDerivation?: false;
  compilerVersion?: string;
}

const prefixId = (pkg: string, id: string): string => (id.startsWith(`${pkg}:`) ? id : `${pkg}:${id}`);

/** The schemas of every fragment, and their diagnostics plus what only the merge can see: collisions and overrides. */
function schemasAndDiagnostics(fragments: ManifestFragment[]): { schemas: Record<string, unknown>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const schemas: Record<string, unknown> = {};
  const schemaOwner = new Map<string, string>();
  const registrations = new Map<string, { pkg: string; id: string }>();

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
  return { schemas, diagnostics };
}

function mergeAuthz(fragments: ManifestFragment[]): AuthzSection | undefined {
  const sections = fragments.flatMap((f) => (f.authz ? [f.authz] : []));
  if (sections.length === 0) return undefined;
  return {
    resources: sections.flatMap((s) => s.resources),
    permissions: sections.flatMap((s) => s.permissions),
    entryPoints: sections.flatMap((s) => s.entryPoints),
    findings: sections.flatMap((s) => s.findings),
    ignores: sections.flatMap((s) => s.ignores),
  };
}

/** `registerAccessResource(DbConfig, ...)` in one package makes a model of another an access resource. */
function withRegisteredTypes(models: ModelEntry[], authz: AuthzSection | undefined): ModelEntry[] {
  const types = new Map(authz?.resources.map((r) => [r.model, r.type]));
  return models.map((m) => (m.accessResource === undefined && types.has(m.id) ? { ...m, accessResource: types.get(m.id) } : m));
}

/** Dependencies come first so that, with "last wins" at runtime, the app overrides its packages. */
export function mergeFragments(app: ManifestFragment, deps: ManifestFragment[], meta: MergeMeta): Manifest {
  const fragments = [...deps, app];
  const { schemas, diagnostics } = schemasAndDiagnostics(fragments);

  const withIds = <T extends { id: string }>(pkg: string, items: T[]): T[] => items.map((i) => ({ ...i, id: prefixId(pkg, i.id) }));
  const collect = <T extends { id: string }>(pick: (f: ManifestFragment) => T[]): T[] => fragments.flatMap((f) => withIds(f.package.name, pick(f)));
  const plain = <T>(pick: (f: ManifestFragment) => T[]): T[] => fragments.flatMap(pick);

  const controllerBases = collect((f) => f.controllerBases ?? []);
  const socketControllerBases = collect((f) => f.socketControllerBases ?? []);
  const classProperties = collect((f) => f.classProperties ?? []);
  const authz = mergeAuthz(fragments);

  const manifest: Manifest = {
    manifestVersion: MANIFEST_VERSION,
    app: meta.app,
    packages: meta.packages,
    services: collect((f) => f.services),
    values: plain((f) => f.values),
    controllers: collect((f) => f.controllers),
    socketControllers: collect((f) => f.socketControllers),
    // The id is global: the runtime and each controller entry bind the literal of `defineContract('<id>')`.
    socketContracts: plain((f) => f.socketContracts),
    ...(controllerBases.length ? { controllerBases } : {}),
    ...(socketControllerBases.length ? { socketControllerBases } : {}),
    ...(classProperties.length ? { classProperties } : {}),
    configModules: plain((f) => f.configModules),
    configUsages: plain((f) => f.configUsages),
    models: withRegisteredTypes(collect((f) => f.models), authz),
    migrations: collect((f) => f.migrations),
    schedules: plain((f) => f.schedules),
    commands: plain((f) => f.commands),
    ...(app.scanFiles?.length ? { scanFiles: app.scanFiles } : {}),
    queueMessages: plain((f) => f.queueMessages),
    ...(authz ? { authz } : {}),
    schemas,
    diagnostics,
    ...(meta.buildEnv ? { buildEnv: meta.buildEnv } : {}),
    ...(meta.schemaDerivation === false ? { schemaDerivation: false as const } : {}),
    ...(meta.compilerVersion ? { compilerVersion: meta.compilerVersion } : {}),
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    hash: '',
  };
  manifest.hash = hashManifest(manifest);
  return manifest;
}
