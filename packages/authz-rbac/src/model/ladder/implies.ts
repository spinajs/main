import { AuthzConfigError } from '@spinajs/authz';

import type { RoleDef } from '../../contracts.js';

const AT = new Set(['self-and-descendants', 'descendants']);

/** @throws AuthzConfigError for a malformed `implies` list or entry, or one naming an unknown role (design §6.5 rule 9) */
export function checkImplies(defs: ReadonlyMap<string, RoleDef>): void {
  for (const [name, def] of defs) {
    const implies: unknown = def.implies;
    if (implies === undefined) continue;
    const at = `rbac role '${name}' (source: ${def.source})`;
    if (!Array.isArray(implies)) throw new AuthzConfigError(`${at}: implies must be an array of { role, at }`);
    for (const entry of implies as unknown[]) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new AuthzConfigError(`${at}: every implies entry must be an object { role, at }`);
      const e = entry as Record<string, unknown>;
      if (typeof e.role !== 'string' || e.role === '') throw new AuthzConfigError(`${at}: an implies entry has no role`);
      if (!defs.has(e.role)) throw new AuthzConfigError(`${at} implies unknown role '${e.role}' (design §6.5 rule 9)`);
      if (typeof e.at !== 'string' || !AT.has(e.at)) throw new AuthzConfigError(`${at}: implies '${e.role}' needs at: 'self-and-descendants' or 'descendants'`);
    }
  }
}
