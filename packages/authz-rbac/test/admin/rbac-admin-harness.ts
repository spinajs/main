import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet, HostSetup } from '@spinajs/authz-testing';

import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import type { AuthzService, Principal } from '@spinajs/authz';

import { ConfigRuleStore, MemoryRoleStore, RbacContributor, RbacModel, RbacService, createRbacExtensions, rbacAssignmentExtension } from '../../src/index.js';
import type { RbacModelOptions } from '../../src/index.js';
import { registerAdminSide, worldRoles } from './admin-harness.js';
import type { AdminSideStores } from './admin-harness.js';

const { instance } = testHost;

/** The stores and the real model of one case. */
export interface RbacAdminStores extends AdminSideStores {
  readonly roles: MemoryRoleStore;
  readonly configRules: ConfigRuleStore;
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
 * adminHarness with L1b's RbacModel in place of TestRbacModel. As registerRbac wires it, the model
 * reads two rule stores: `world.rbac.rules` as config rules (ConfigRuleStore, checked at boot) and
 * the admin MemoryRuleStore that rule.put writes, read per path like DB rules. A committed write
 * reaches the model through the change bus (the domain invalidates the model's assignment cache).
 * Lane handle `rbacStore` only reads link rows (B38.store, run with facet `store`); it cannot plant
 * assignment rows.
 */
export function rbacAdminHarness(opts: RbacAdminHarnessOptions = {}): BehaviourHarness {
  return hostHarness({
    facets: ['admin', 'rbac', 'ladders', 'links', 'rules', ...(opts.facets ?? [])],
    kitScopeAttributes: false,
    register(host) {
      const { roles: defs, ladders } = worldRoles(host);
      const roles = new MemoryRoleStore(defs, ladders);
      const side = registerAdminSide(host, roles, { configRules: true });
      const configRules = new ConfigRuleStore(host.world.rbac?.rules ?? []);
      // The kit clock moves the assignment cache TTL with the case's `advance` steps.
      const options: RbacModelOptions = { roles, assignments: side.assignments, links: side.links, rules: [configRules, side.rules], clock: host.kit.clock };
      const model = new RbacModel({ ...options, extensions: [...createRbacExtensions(options), rbacAssignmentExtension(options, { rules: true })] });
      host.container.register(instance(model)).as(AuthorizationModel);
      host.container.register(instance(new RbacContributor(model))).as(AuthzContributor);
      STORES.set(host.container, { ...side, roles, configRules, model });
    },
    extend(host, session) {
      const { events, links, model } = rbacAdminStores(host);
      const service = new RbacService(model);
      const rbacStore = {
        insertAssignment: (): Promise<void> => Promise.reject(new Error('rbacAdminHarness: rbacStore cannot plant assignment rows')),
        // The raw rows are what the kit inspects, and MemoryLinkStore keeps them private.
        linkRows: async () => [...links['rows'].values()].map((r) => ({ ...r.link, hash: r.hash.toString('hex') })),
      };
      return {
        admin: (session.authz as unknown as AuthzService).admin(),
        lane: { adminEvents: events, rbacLinks: { principal: (token: string, companion?: Principal) => service.principalForToken(token, companion) }, rbacStore },
      };
    },
  });
}
