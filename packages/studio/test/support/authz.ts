import { GLOBAL } from '@spinajs/authz';
import { MemoryAssignmentStore, MemoryRoleStore, RbacModel } from '@spinajs/authz-rbac';
import type { GrantDef, LadderDef, RoleDef } from '@spinajs/authz-rbac';

const role = (name: string, grants: readonly (string | GrantDef)[], parents: readonly string[] = [], extra: Partial<RoleDef> = {}): RoleDef => ({
  name,
  extends: parents,
  grants: grants.map((g) => (typeof g === 'string' ? { permission: g } : g)),
  assignable: true,
  source: 'studio-test',
  ...extra,
});

/** Strings no Studio reply may carry: a grant's resource pattern, a role description, an assignment's principal. */
export const RBAC_SECRETS = ['tenant-SECRET-pattern', 'SECRET-description', 'carol-SECRET'] as const;

export const RBAC_ROLES: readonly RoleDef[] = [
  role('viewer', ['order:read']),
  role('editor', ['order:write', { permission: 'order:read', on: [{ type: 'order', id: `${RBAC_SECRETS[0]}-*` }] }], ['viewer'], { description: RBAC_SECRETS[1] }),
  role('member', ['order:read'], [], { ladder: 'project' }),
  role('owner', ['order:write'], [], { ladder: 'project' }),
  role('blocked', ['order:write'], [], { deny: true, assignable: false }),
];

export const RBAC_LADDERS: readonly LadderDef[] = [{ name: 'project', roles: ['member', 'owner'] }];

/** RBAC over in-memory roles, a ladder and one assignment. It reads no configuration, so it can be built before the test host exists. */
export function rbacModel(): RbacModel {
  return new RbacModel({
    roles: new MemoryRoleStore(RBAC_ROLES, RBAC_LADDERS),
    assignments: new MemoryAssignmentStore([{ id: 'a1', subject: { type: 'user', id: RBAC_SECRETS[2] }, role: 'editor', scope: GLOBAL, source: 'studio-test' }]),
  });
}
