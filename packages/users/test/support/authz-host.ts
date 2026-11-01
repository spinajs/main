import { AuthorizationModel, AuthzContributor, AuthzService, GLOBAL } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';
import type { Assignment } from '@spinajs/authz-rbac';
import { AdminAssignmentStore, AssignmentStore, ConfigRoleStore, DbAssignmentStore, RbacContributor, RbacModel, RbacService, RoleStore } from '@spinajs/authz-rbac';
import { Container, DI, Inject, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn/contracts';

import { TestPasswordService } from './password-service.js';

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
let modelRegistered = false;

const modelOf = (c: IContainer): RbacModel => (c.resolve(UsersTestRbac) as UsersTestRbac).model;
// Named, so the test configuration's authz.models can list it.
const UsersTestRbacModel = (c: IContainer): RbacModel => modelOf(c);
const contributor = (c: IContainer): RbacContributor => new RbacContributor(modelOf(c));
const service = (c: IContainer): RbacService => new RbacService(modelOf(c));

/**
 * A real root authz host over the users test database: roles from `authz.rbac.roles` of the test
 * configuration, assignments in `authz_assignment` (authz-rbac's migrations run with the users ones),
 * `AuthzAdmin` on `DbAuthzAdminBackend` with `DefaultAdminGuard`, an `RbacService` over the model (as
 * an RbacModel built by DI gives); and the test `PasswordService` that
 * `create()` needs. Registered once per process; the
 * suites' `DI.clearCache()` makes the next resolve boot a fresh root service on the fresh database.
 */
export function registerAuthzHost(): void {
  if (!registered) {
    registered = true;
    DI.register(ConfigRoleStore).as(RoleStore);
    DI.register(DbAssignmentStore).as(AssignmentStore);
    DI.register(DbAssignmentStore).as(AdminAssignmentStore);
    DI.register(TestPasswordService).as(PasswordService);
  }
  if (!modelRegistered) {
    modelRegistered = true;
    DI.register(UsersTestRbacModel).as(AuthorizationModel);
    DI.register(contributor).as(AuthzContributor);
    DI.register(service).as(RbacService);
  }
}

/**
 * Removes the root model, contributor and service of registerAuthzHost(), for a suite whose root lists no model: the
 * contributor of a model no domain activated fails that root's boot. The next registerAuthzHost() adds them again.
 */
export function releaseAuthzHost(): void {
  if (!modelRegistered) return;
  modelRegistered = false;
  DI.unregister(AuthorizationModel, UsersTestRbacModel);
  DI.unregister(AuthzContributor, contributor);
  DI.unregister(RbacService, service);
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
