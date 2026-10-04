import { AuthorizationModel, AuthzContributor, AuthzService, GLOBAL } from '@spinajs/authz';
import type { Assignment, AuthzAdmin } from '@spinajs/authz';
import { AdminAssignmentStore, AssignmentStore, ConfigRoleStore, DbAssignmentStore, RbacContributor, RbacModel, RoleStore } from '@spinajs/authz-rbac';
import { Container, DI, Inject, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

/** One RbacModel per DI cache lifetime, shared by the model and its contributor registrations. */
@Singleton()
@Inject(Container)
class UsersTestRbac {
  public readonly model: RbacModel;

  constructor(container: IContainer) {
    this.model = new RbacModel({ roles: container.resolve(RoleStore) as RoleStore, assignments: container.resolve(AssignmentStore) as AssignmentStore });
  }
}

let registered = false;

/**
 * A real root authz host over the users test database: roles from `authz.rbac.roles` of the test
 * configuration, assignments in `authz_assignment` (authz-rbac's migrations run with the users ones),
 * `AuthzAdmin` on `DbAuthzAdminBackend` with `DefaultAdminGuard`. Registered once per process; the
 * suites' `DI.clearCache()` makes the next resolve boot a fresh root service on the fresh database.
 */
export function registerAuthzHost(): void {
  if (registered) {
    return;
  }
  registered = true;

  DI.register(ConfigRoleStore).as(RoleStore);
  DI.register(DbAssignmentStore).as(AssignmentStore);
  DI.register(DbAssignmentStore).as(AdminAssignmentStore);
  DI.register((c: IContainer) => (c.resolve(UsersTestRbac) as UsersTestRbac).model).as(AuthorizationModel);
  DI.register((c: IContainer) => new RbacContributor((c.resolve(UsersTestRbac) as UsersTestRbac).model)).as(AuthzContributor);
}

export async function rootAuthz(): Promise<AuthzService> {
  return (await DI.resolve(AuthzService)) as AuthzService;
}

export async function rootAdmin(): Promise<AuthzAdmin> {
  return (await rootAuthz()).admin();
}

/** Live GLOBAL assignments of user `uuid`. */
export async function globalRolesOf(uuid: string): Promise<string[]> {
  const store = (await DI.resolve(AssignmentStore)) as AssignmentStore;
  const rows: readonly Assignment[] = await store.forSubjects([{ type: 'user', id: uuid }], new Date());
  return rows.filter((a) => a.scope.type === GLOBAL.type).map((a) => a.role);
}
