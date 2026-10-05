import { AuthorizationModel, AuthzContributor, AuthzService, GLOBAL, SYSTEM } from '@spinajs/authz';
import type { Assignment, AuthzAdmin, AuthzCommand } from '@spinajs/authz';
import { AdminAssignmentStore, AssignmentStore, ConfigRoleStore, DbAssignmentStore, RbacContributor, RbacModel, RoleStore } from '@spinajs/authz-rbac';
import { Container, DI, Inject, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn/contracts';

import { TestPasswordService } from './password-service.js';

/** One RbacModel per DI cache lifetime, shared by the model and its contributor registrations. */
@Singleton()
@Inject(Container)
class UsersHttpTestRbac {
  public readonly model: RbacModel;

  constructor(container: IContainer) {
    this.model = new RbacModel({ roles: container.resolve(RoleStore) as RoleStore, assignments: container.resolve(AssignmentStore) as AssignmentStore });
  }
}

let registered = false;

/**
 * A real root authz host over the test database: roles from `authz.rbac.roles`, assignments in
 * `authz_assignment`, `AuthzAdmin` on `DbAuthzAdminBackend` with `DefaultAdminGuard`, and the test
 * `PasswordService`. Registered once per process; `DI.clearCache()` makes the next resolve boot a fresh
 * root service on the fresh database.
 */
export function registerAuthzHost(): void {
  if (registered) {
    return;
  }
  registered = true;

  DI.register(ConfigRoleStore).as(RoleStore);
  DI.register(DbAssignmentStore).as(AssignmentStore);
  DI.register(DbAssignmentStore).as(AdminAssignmentStore);
  DI.register((c: IContainer) => (c.resolve(UsersHttpTestRbac) as UsersHttpTestRbac).model).as(AuthorizationModel);
  DI.register((c: IContainer) => new RbacContributor((c.resolve(UsersHttpTestRbac) as UsersHttpTestRbac).model)).as(AuthzContributor);
  DI.register(TestPasswordService).as(PasswordService);
}

export async function rootAuthz(): Promise<AuthzService> {
  return (await DI.resolve(AuthzService)) as AuthzService;
}

export async function rootAdmin(): Promise<AuthzAdmin> {
  return (await rootAuthz()).admin();
}

/** Grants each role to `user:<uuid>` at GLOBAL as SYSTEM. */
export async function seedRoles(uuid: string, roles: readonly string[]): Promise<void> {
  const commands: AuthzCommand[] = roles.map((role) => ({ kind: 'assignment.grant', subject: { type: 'user', id: uuid }, role, scope: GLOBAL }));
  const results = await (await rootAdmin()).execute(SYSTEM, commands, { reason: 'test seed' });
  const failed = results.find((r) => !r.ok);
  if (failed && !failed.ok) {
    throw new Error(`seed of ${roles.join(', ')} for ${uuid} failed: ${failed.error.code} ${failed.error.message}`);
  }
}

/** Revokes the GLOBAL assignments of `roles` from `user:<uuid>` as SYSTEM. */
export async function unseedRoles(uuid: string, roles: readonly string[]): Promise<void> {
  const commands: AuthzCommand[] = roles.map((role) => ({ kind: 'assignment.revokeWhere', subject: { type: 'user', id: uuid }, role, scope: GLOBAL }));
  await (await rootAdmin()).execute(SYSTEM, commands, { reason: 'test seed' });
}

/** Live GLOBAL assignments of user `uuid`. */
export async function globalRolesOf(uuid: string): Promise<string[]> {
  const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
  const rows: readonly Assignment[] = await store.forSubjects([{ type: 'user', id: uuid }], new Date());
  return rows.filter((a) => a.scope.type === GLOBAL.type).map((a) => a.role);
}
