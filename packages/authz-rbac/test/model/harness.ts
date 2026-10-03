import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet, HarnessSession, HostSetup } from '@spinajs/authz-testing';

import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel } from '../../src/index.js';
import type { LinkStore, RbacExtension, RuleStore } from '../../src/index.js';

export interface RbacHarnessOptions {
  /** Added to the host facets and `rbac`. */
  readonly facets?: readonly Facet[];
  /** Per case; default: the model's DEFAULT_RBAC_EXTENSIONS. */
  readonly extensions?: (host: HostSetup) => readonly RbacExtension[];
  /** Per case, built from `host.world.rbac` (rules, links). */
  readonly rules?: (host: HostSetup) => RuleStore;
  readonly links?: (host: HostSetup) => LinkStore;
  /** After the model and its contributor are registered, before the domain boots. */
  register?(host: HostSetup, model: RbacModel): void | Promise<void>;
  extend?(host: HostSetup, session: HarnessSession): Partial<HarnessSession> | Promise<Partial<HarnessSession>>;
}

/** A host test domain per case with the real RbacModel over in-memory stores loaded from `world.rbac`. */
export const rbacHarness = (opts: RbacHarnessOptions = {}): BehaviourHarness =>
  hostHarness({
    facets: ['rbac', ...(opts.facets ?? [])],
    async register(host) {
      const rbac = host.world.rbac ?? {};
      const model = new RbacModel({
        roles: new MemoryRoleStore(rbac.roles ?? [], rbac.ladders ?? []),
        assignments: new MemoryAssignmentStore(rbac.assignments ?? []),
        ...(opts.rules ? { rules: opts.rules(host) } : {}),
        ...(opts.links ? { links: opts.links(host) } : {}),
        ...(opts.extensions ? { extensions: opts.extensions(host) } : {}),
      });
      host.container.register(testHost.instance(model)).as(AuthorizationModel);
      host.container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
      await opts.register?.(host, model);
    },
    ...(opts.extend ? { extend: opts.extend } : {}),
  });
