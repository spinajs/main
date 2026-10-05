import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet, HostSetup } from '@spinajs/authz-testing';

import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';

import { MemoryRoleStore, RbacContributor, RbacModel, RbacService } from '../../src/index.js';
import { registerAdminSide, worldRoles } from './admin-harness.js';
import type { AdminSideStores } from './admin-harness.js';

const { instance } = testHost;

/** The stores and the real model of one case. */
export interface RbacAdminStores extends AdminSideStores {
  readonly roles: MemoryRoleStore;
  readonly model: RbacModel;
}

export interface RbacAdminHarnessOptions {
  readonly facets?: readonly Facet[];
}

const STORES = new WeakMap<object, RbacAdminStores>();

/** The stores of the case whose test domain is `container`. */
export function rbacAdminStores(host: Pick<HostSetup, 'container'>): RbacAdminStores {
  const s = STORES.get(host.container);
  if (!s) throw new Error('rbacAdminHarness: no stores for this container');
  return s;
}

/**
 * adminHarness with L1b's RbacModel in place of TestRbacModel: the model reads the assignment, link
 * and rule stores AuthzAdmin writes through, and the MemoryRoleStore the guard reads. A committed
 * write reaches the model through the change bus (the domain invalidates the model's assignment
 * cache). Lane handles `adminEvents` and `rbacLinks` (tokens resolved by RbacService).
 */
export function rbacAdminHarness(opts: RbacAdminHarnessOptions = {}): BehaviourHarness {
  return hostHarness({
    facets: ['admin', 'rbac', 'ladders', 'links', 'rules', ...(opts.facets ?? [])],
    kitScopeAttributes: false,
    register(host) {
      const { roles: defs, ladders } = worldRoles(host);
      const roles = new MemoryRoleStore(defs, ladders);
      const side = registerAdminSide(host, roles);
      // The kit clock moves the assignment cache TTL with the case's `advance` steps.
      const model = new RbacModel({ roles, assignments: side.assignments, links: side.links, rules: side.rules, clock: host.kit.clock });
      host.container.register(instance(model)).as(AuthorizationModel);
      host.container.register(instance(new RbacContributor(model))).as(AuthzContributor);
      STORES.set(host.container, { ...side, roles, model });
    },
    extend(host, session) {
      const { events, model } = rbacAdminStores(host);
      const service = new RbacService(model);
      return {
        admin: (session.authz as unknown as AuthzService).admin(),
        lane: { adminEvents: events, rbacLinks: { principal: (token: string, companion?: Principal) => service.principalForToken(token, companion) } },
      };
    },
  });
}
