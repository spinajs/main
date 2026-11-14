import type { Diagnostic, Manifest } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';
import { accessRefs, configPermissions, entryName, extrasOf, ownEntries, permissionsOf, resourceOf, withoutIgnored, type AccessExtras, type EntryPoint, type PermissionConfig } from './authz-entries.js';

/** The type a literal extractor yields; a `fromModel` model that is no access resource yields none and is a finding itself. */
function extractedType(manifest: Manifest, resource: NonNullable<AccessExtras['resource']>): { type?: string; problem?: string } {
  if (resource.type !== undefined) return { type: resource.type };
  const model = manifest.models.find((m) => m.id === resource.model);
  if (!model) return {};
  return model.accessResource ? { type: model.accessResource } : { problem: `fromModel(${model.className}) names a model that is no @AccessResource` };
}

function mismatches(manifest: Manifest, e: EntryPoint, configured: Map<string, PermissionConfig>): string[] {
  const out: string[] = [];
  for (const ref of accessRefs(e)) {
    const resource = extrasOf(ref)?.resource;
    if (!resource) continue;
    const { type, problem } = extractedType(manifest, resource);
    if (problem) out.push(problem);
    if (type === undefined) continue;
    for (const permission of permissionsOf(ref)) {
      const types = configured.get(permission)?.types ?? [resourceOf(permission)];
      if (!types.includes(type)) out.push(`its resource extractor yields '${type}', but ${permission} is checked on ${types.map((t) => `'${t}'`).join(', ')}`);
    }
  }
  return out;
}

export const resourceMismatch: DoctorRule = {
  code: 'AUTHZ007',
  describe: 'The resource extractor of an entry point yields a type its permissions are checked on, and fromModel names an access resource',
  run(manifest, ctx) {
    const configured = configPermissions(ctx.config);
    const out: Diagnostic[] = [];
    for (const e of ownEntries(manifest)) {
      for (const problem of mismatches(manifest, e, configured)) out.push(diagnostic('AUTHZ007', 'warning', `${entryName(e)}: ${problem}.`, e.source));
    }
    return withoutIgnored(manifest, out);
  },
};
