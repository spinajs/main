import type { Permission } from '@spinajs/authz';

import type { RbacModel } from '../model/model.js';
import { modelTables } from '../model/service.js';

/** Roles whose grants give `permission` (extends, ladders and permission implies are in the grant index), plus every role that implies one of them. */
export function grantingRoles(model: RbacModel, permission: Permission): ReadonlySet<string> {
  const index = model.grantIndex();
  const { implies } = modelTables(model);
  const names = [...model.roleGraph().names];
  const out = new Set(names.filter((r) => index.grants(r, permission).length > 0));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of names) {
      if (!out.has(r) && implies?.of(r).some((e) => out.has(e.role))) {
        out.add(r);
        grew = true;
      }
    }
  }
  return out;
}
