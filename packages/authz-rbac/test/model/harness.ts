import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import type { Assignment, Permission, Principal, ResourceType } from '@spinajs/authz';
import { evaluateFilter, hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, Facet, HarnessSession, HostSetup } from '@spinajs/authz-testing';

import { MemoryAdminAssignmentStore, MemoryAssignmentStore, MemoryLinkStore, MemoryRoleStore, RbacContributor, RbacModel, RbacService } from '../../src/index.js';
import type { AssignmentStore, RbacExtension, RbacModelOptions, RuleStore } from '../../src/index.js';

export interface RbacHarnessOptions {
  /** Added to the host facets, `rbac` and `list`. */
  readonly facets?: readonly Facet[];
  /** Per case, with the model's options (stores); default: the model's DEFAULT_RBAC_EXTENSIONS. */
  readonly extensions?: (host: HostSetup, model: RbacModelOptions) => readonly RbacExtension[];
  /** Per case, built from `host.world.rbac.rules`. */
  readonly rules?: (host: HostSetup) => RuleStore;
  /** After the model and its contributor are registered, before the domain boots. */
  register?(host: HostSetup, model: RbacModel): void | Promise<void>;
  extend?(host: HostSetup, session: HarnessSession): Partial<HarnessSession> | Promise<Partial<HarnessSession>>;
}

/**
 * A host test domain per case with the real RbacModel over in-memory stores loaded from `world.rbac`.
 * With `world.rbac.links`, L9's MemoryLinkStore holds the links that are not revoked (each with its
 * `link:<id>` assignment) and the lane handle `rbacLinks` resolves tokens through RbacService.
 */
export const rbacHarness = (opts: RbacHarnessOptions = {}): BehaviourHarness => {
  const models = new WeakMap<HostSetup, RbacModel>();
  return hostHarness({
    facets: ['rbac', 'list', ...(opts.facets ?? [])],
    async register(host) {
      const rbac = host.world.rbac ?? {};
      let assignments: AssignmentStore = new MemoryAssignmentStore(rbac.assignments ?? []);
      let links: MemoryLinkStore | undefined;
      if (rbac.links?.length) {
        // A revoked link keeps its assignment: the link principal's empty ceiling must do the denying.
        const revoked = rbac.links.filter((l) => l.revoked).map((l): Assignment => ({ id: `link-${l.id}`, subject: { type: 'link', id: l.id }, role: l.role, scope: l.scope, ...(l.tags ? { tags: l.tags } : {}), source: 'test' }));
        const store = new MemoryAdminAssignmentStore({ assignments: [...(rbac.assignments ?? []), ...revoked] });
        links = new MemoryLinkStore(store, {
          links: rbac.links.filter((l) => !l.revoked).map((l) => ({ link: { id: l.id, scope: l.scope, expiresAt: l.expiresAt ?? null, attributes: l.attributes ?? {} }, token: l.token, role: l.role, ...(l.tags ? { tags: l.tags } : {}) })),
        });
        assignments = store;
      }
      const options: RbacModelOptions = {
        roles: new MemoryRoleStore(rbac.roles ?? [], rbac.ladders ?? []),
        assignments,
        // The cache TTL then moves with the case's `advance` steps.
        clock: host.kit.clock,
        ...(opts.rules ? { rules: opts.rules(host) } : {}),
        ...(links ? { links } : {}),
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
      const extra = await opts.extend?.(host, session);
      const service = model?.linkStore ? new RbacService(model) : undefined;
      const lane = { ...session.lane, ...(service ? { rbacLinks: { principal: (token: string, companion?: Principal) => service.principalForToken(token, companion) } } : {}), ...extra?.lane };
      return { ...own, ...extra, lane };
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
