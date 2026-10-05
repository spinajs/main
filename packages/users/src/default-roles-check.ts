import { AuthzConfigError, AuthzContributor, GLOBAL } from '@spinajs/authz';
import type { AuthzContribution } from '@spinajs/authz';
import { RoleStore, assignmentProblem, compileRoles } from '@spinajs/authz-rbac';
import type { LadderDef, RoleDef } from '@spinajs/authz-rbac';
import { Configuration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';

import { DEFAULT_ROLES_KEY, defaultRoles } from './role-assignments.js';

/**
 * Checks `authz.rbac.defaultRoles` once, when the root authz domain boots (RFC L1-1, decision 3): each
 * role must be defined, assignable and allowed at GLOBAL, or the boot fails with an `AuthzConfigError`
 * naming the key and the role. Otherwise a bad default would only surface at the first sign-up.
 *
 * A contributor because the host asks every one of them during each domain boot, after the models have
 * initialised; it contributes nothing. The roles come from the root's `RoleStore`s, compiled the way the
 * RBAC model compiles them, so the check does not depend on how an app registers its model.
 */
@Injectable(AuthzContributor)
export class DefaultRolesBootCheck extends AuthzContributor {
  public async contribute(domain: string): Promise<AuthzContribution> {
    if (domain !== 'root') {
      return {};
    }

    const configuration = (await DI.resolve(Configuration)) as Configuration;
    const roles = defaultRoles(configuration.get(DEFAULT_ROLES_KEY.split('.')));
    if (roles.length === 0) {
      return {};
    }

    if (!DI.RootContainer.hasRegistered(RoleStore)) {
      throw new AuthzConfigError(`${DEFAULT_ROLES_KEY} names roles, but no RoleStore is registered to define them`);
    }

    const defs: RoleDef[] = [];
    const ladders: LadderDef[] = [];
    for (const store of (await DI.RootContainer.resolve(Array.chainOf(RoleStore))) as RoleStore[]) {
      const loaded = await store.load();
      defs.push(...loaded.roles);
      ladders.push(...loaded.ladders);
    }

    const graph = compileRoles(defs, ladders);
    for (const role of roles) {
      const problem = assignmentProblem(graph, role, GLOBAL);
      if (problem) {
        throw new AuthzConfigError(`${DEFAULT_ROLES_KEY}: role '${role}' cannot be given to new users (${problem})`);
      }
    }

    return {};
  }
}
