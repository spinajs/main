import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import type { Permission, Principal, ResourceType } from '@spinajs/authz';
import { evaluateFilter, hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet, HarnessSession, HostSetup } from '@spinajs/authz-testing';

import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel } from '../../src/index.js';
import type { LinkStore, RbacExtension, RbacModelOptions, RuleStore } from '../../src/index.js';

export interface RbacHarnessOptions {
  /** Added to the host facets, `rbac` and `list`. */
  readonly facets?: readonly Facet[];
  /** Per case, with the model's options (stores); default: the model's DEFAULT_RBAC_EXTENSIONS. */
  readonly extensions?: (host: HostSetup, model: RbacModelOptions) => readonly RbacExtension[];
  /** Per case, built from `host.world.rbac` (rules, links). */
  readonly rules?: (host: HostSetup) => RuleStore;
  readonly links?: (host: HostSetup) => LinkStore;
  /** After the model and its contributor are registered, before the domain boots. */
  register?(host: HostSetup, model: RbacModel): void | Promise<void>;
  extend?(host: HostSetup, session: HarnessSession): Partial<HarnessSession> | Promise<Partial<HarnessSession>>;
}

/** A host test domain per case with the real RbacModel over in-memory stores loaded from `world.rbac`. */
export const rbacHarness = (opts: RbacHarnessOptions = {}): BehaviourHarness => {
  const models = new WeakMap<HostSetup, RbacModel>();
  return hostHarness({
    facets: ['rbac', 'list', ...(opts.facets ?? [])],
    async register(host) {
      const rbac = host.world.rbac ?? {};
      const options: RbacModelOptions = {
        roles: new MemoryRoleStore(rbac.roles ?? [], rbac.ladders ?? []),
        assignments: new MemoryAssignmentStore(rbac.assignments ?? []),
        // The cache TTL then moves with the case's `advance` steps.
        clock: host.kit.clock,
        ...(opts.rules ? { rules: opts.rules(host) } : {}),
        ...(opts.links ? { links: opts.links(host) } : {}),
      };
      const model = new RbacModel({ ...options, ...(opts.extensions ? { extensions: opts.extensions(host, options) } : {}) });
      models.set(host, model);
      host.container.register(testHost.instance(model)).as(AuthorizationModel);
      host.container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
      await opts.register?.(host, model);
    },
    async extend(host, session) {
      const model = models.get(host);
      const own: Partial<HarnessSession> = model ? { list: (principal, permission, type) => list(host, session, model, principal, permission, type) } : {};
      return { ...own, ...(await opts.extend?.(host, session)) };
    },
  });
};

/** The world rows the domain's type-level residual selects, evaluated in memory with the model's native filters (B06). */
async function list(host: HostSetup, session: HarnessSession, model: RbacModel, principal: Principal, permission: Permission, type: ResourceType): Promise<readonly string[]> {
  const authz = session.authz;
  if (!authz?.filter) throw new Error('rbacHarness list: the session has no filter');
  const residual = await authz.filter(principal, permission, type);
  // Under 'inherit' the models speak for the delegate, so principal.* refs read the delegate.
  const speaker = principal.onBehalfOf && principal.delegation === 'inherit' ? principal.onBehalfOf : principal;
  const nativeFilters = model.extensions.flatMap((e) => e.nativeFilters?.() ?? []);
  const context = host.kit.context();
  const out: string[] = [];
  for (const row of host.kit.rows(type)) {
    if ((await evaluateFilter(residual, row, { principal: speaker, actor: principal, ref: { type, id: row.id }, context, nativeFilters })) === true) out.push(row.id);
  }
  return out;
}
