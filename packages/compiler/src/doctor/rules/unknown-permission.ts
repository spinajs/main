import type { Diagnostic } from '@spinajs/manifest';
import { diagnostic, type DoctorRule } from '../rule.js';
import { accessRefs, configPermissions, entryName, ownEntries, permissionsOf, resourceOf, withoutIgnored } from './authz-entries.js';

export const unknownPermission: DoctorRule = {
  code: 'AUTHZ005',
  describe: 'Every permission an entry point of the app checks is in the catalogue (with --config)',
  run(manifest, ctx) {
    if (!ctx.config) return [];
    const configured = configPermissions(ctx.config);
    const catalogue = new Set([...(manifest.authz?.permissions ?? []).map((p) => p.name), ...configured.keys()]);
    // Adapters register permissions the build cannot see; only a type the catalogue knows is judged.
    const knownTypes = new Set([...(manifest.authz?.resources ?? []).map((r) => r.type), ...[...catalogue].map(resourceOf)]);
    const out: Diagnostic[] = [];
    for (const e of ownEntries(manifest)) {
      const checked = new Set(accessRefs(e).flatMap(permissionsOf));
      for (const permission of checked) {
        if (catalogue.has(permission) || !knownTypes.has(resourceOf(permission))) continue;
        out.push(diagnostic('AUTHZ005', 'warning', `${entryName(e)} checks ${permission}, which is neither in authz.permissions nor one of the read|create|update|delete permissions of an access resource.`, e.source));
      }
    }
    return withoutIgnored(manifest, out);
  },
};
