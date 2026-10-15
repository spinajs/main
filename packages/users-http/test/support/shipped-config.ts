import type { Configuration } from '@spinajs/configuration';

type Cfg = Pick<Configuration, 'get' | 'set'>;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The shipped fragments of other installed packages (teams: its `team` ladder and the `team.owner` keep holder) name
 * roles a suite's own role set drops, and the engine refuses to boot on an unknown role.
 */
export function dropUnknownRoleRefs(cfg: Cfg): void {
  const roles = cfg.get<Record<string, unknown>>(['authz', 'rbac', 'roles']) ?? {};
  const ladders = cfg.get<Record<string, { roles?: unknown }>>(['authz', 'rbac', 'ladders']);
  if (isRecord(ladders)) {
    const known = Object.entries(ladders).filter(([, l]) => !Array.isArray(l?.roles) || l.roles.every((r) => typeof r === 'string' && r in roles));
    cfg.set(['authz', 'rbac', 'ladders'], Object.fromEntries(known));
  }
  const keep = cfg.get<{ role?: string }[]>(['authz', 'admin', 'guard', 'keepHolders']);
  if (Array.isArray(keep)) cfg.set(['authz', 'admin', 'guard', 'keepHolders'], keep.filter((h) => typeof h?.role !== 'string' || h.role in roles));
}

/** Boot rule 12 refuses the shipped list permissions (configuration:read, team:read, …) on kit models, which cannot plan lists. */
export function unlistShippedPermissions(cfg: Cfg): void {
  for (const [name, def] of Object.entries(cfg.get<Record<string, unknown>>(['authz', 'permissions']) ?? {})) {
    if (isRecord(def) && def.list === true) cfg.set(['authz', 'permissions', name, 'list'], false);
  }
}
