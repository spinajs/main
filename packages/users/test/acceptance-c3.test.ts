import { Configuration } from '@spinajs/configuration';
import { ResourceNotFound } from '@spinajs/exceptions';
import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { PrincipalFactory } from '@spinajs/authn/contracts';
import type { AuthnFacts, IdentityRef } from '@spinajs/authn/contracts';
import { AssignmentStore, ConfigRoleStore, MemoryAdminAssignmentStore, RbacContributor, RbacModel, RbacService, RoleStore } from '@spinajs/authz-rbac';
import type { LadderDef, RoleDef } from '@spinajs/authz-rbac';
import { AbacContributor, AbacModel, ConfigPolicyStore } from '@spinajs/authz-abac';
import { hostHarness, runBehaviour, testHost, withAuthn } from '@spinajs/authz-testing';
import type { BehaviourHarness, World } from '@spinajs/authz-testing';

import { AuthzImpersonationGuard } from '../src/index.js';

const { instance } = testHost;

const roleConfig = (roles: readonly RoleDef[]) => Object.fromEntries(roles.map(({ name, source: _source, ...def }) => [name, def]));
const ladderConfig = (ladders: readonly LadderDef[]) => Object.fromEntries(ladders.map(({ name, ...def }) => [name, def]));

/** The world's principals as the impersonation session would carry them. */
class WorldPrincipalFactory extends PrincipalFactory {
  constructor(private readonly world: World) {
    super();
  }

  public async principalOf(id: IdentityRef, facts: AuthnFacts): Promise<Principal> {
    const found = Object.values(this.world.principals ?? {}).find((p) => p.type === id.type && p.id === id.id);
    if (!found) {
      throw new ResourceNotFound(`No ${id.type} ${id.id}`);
    }
    return { ...found, source: 'session', authn: facts };
  }
}

/**
 * This file must run before any suite registers users' own TestConfiguration in root: DI keys types by name, so the
 * kit's TestConfiguration cannot be installed after it. The file name sorts first (acceptance.test.ts relies on the same).
 *
 * The kit's host harness with authz-rbac's `RbacModel` over the world's roles (when the world has an `rbac` section) and
 * authz-abac's `AbacModel` over its policies, in the test domain, which the guard reads as the access domain.
 */
function impersonationHarness(): BehaviourHarness {
  return hostHarness({
    facets: ['rbac', 'ladders', 'abac', 'conditions', 'impersonation'],
    kitScopeAttributes: false,
    async register(host) {
      const c = host.container;
      host.setConfig(['authz', 'http', 'access', 'domain'], host.domain);

      if (host.world.rbac) {
        const rbac = host.world.rbac;
        host.setConfig(['authz', 'rbac', 'roles'], roleConfig((rbac.roles ?? []) as readonly RoleDef[]));
        if (rbac.ladders) host.setConfig(['authz', 'rbac', 'ladders'], ladderConfig(rbac.ladders as readonly LadderDef[]));

        const assignments = new MemoryAdminAssignmentStore({ assignments: rbac.assignments });
        const roles = new ConfigRoleStore((await c.resolve(Configuration)) as Configuration);
        const model = new RbacModel({ roles, assignments, clock: host.kit.clock });
        c.register(instance(roles)).as(RoleStore);
        c.register(instance(assignments)).as(AssignmentStore);
        c.register(instance(model)).as(AuthorizationModel);
        c.register(instance(new RbacContributor(model))).as(AuthzContributor);
        c.register(instance(new RbacService(model))).as(RbacService);
      }

      if (host.world.abac) {
        const model = new AbacModel({ stores: [new ConfigPolicyStore(host.world.abac.policies)] });
        c.register(instance(model)).as(AuthorizationModel);
        c.register(instance(new AbacContributor(model))).as(AuthzContributor);
      }
    },
    extend: (host) => {
      const guard = new AuthzImpersonationGuard({ principals: new WorldPrincipalFactory(host.world) });
      return {
        lane: {
          impersonationGuard: {
            // World principals carry no authn facts; the guard asks for those of a signed-in session.
            allowed: (actor, target) => guard.allowed(actor.authn ? actor : withAuthn(actor), target),
          },
        },
      };
    },
  });
}

describe('plan C3 task 2 acceptance: the impersonation guard over a real host', function () {
  this.timeout(60000);

  runBehaviour(['B26.impersonation', 'B26.abac', 'B45.rbac'], impersonationHarness, { strict: true });
});
