import { AuthorizationModel, AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { Configuration } from '@spinajs/configuration';
import type { Class, Factory, IContainer } from '@spinajs/di';

import { AssignmentStore, LinkStore, MembershipStore, RoleStore, RuleStore } from '../contracts.js';
import type { RbacExtension } from '../model/evaluate.js';
import { RbacContributor } from '../model/contributor.js';
import { RbacLinkResolver } from '../model/links/resolver.js';
import { RbacModel } from '../model/model.js';
import type { RbacModelOptions } from '../model/model.js';
import { ruleStoreParts } from '../model/rules/extension.js';
import { RbacService } from '../model/service.js';
import type { RbacServiceOptions } from '../model/service.js';
import { rbacStoreNames } from '../stores/defaults.js';
import type { RbacStoreKind } from '../stores/defaults.js';
import { registerRbacStores, storeClass } from '../stores/register.js';

export interface RegisterRbacOptions {
  /** Default: one instance from each factory of DEFAULT_RBAC_EXTENSIONS, built with the store options. */
  readonly extensions?: (options: RbacModelOptions) => readonly RbacExtension[];
  readonly log?: RbacModelOptions['log'];
  readonly clock?: RbacModelOptions['clock'];
  readonly service?: Omit<RbacServiceOptions, 'links'>;
}

export interface RegisteredRbac {
  readonly model: RbacModel;
  readonly contributor: RbacContributor;
  readonly service: RbacService;
  /** authz-http's LinkResolver over `service`; see RbacLinkResolver for the binding. */
  readonly linkResolver: RbacLinkResolver;
}

/** The name `check-config --explain-role` resolves the service by. */
export const RBAC_SERVICE_NAME = 'RbacService';

const instance =
  <T>(value: T): Factory<T> =>
  () =>
    value;

/**
 * Wires RBAC into `container` (a domain's; the root for the CLI): the stores `authz.rbac.stores`
 * names (registerRbacStores), an RbacModel over them as an AuthorizationModel, its RbacContributor
 * as an AuthzContributor, and an RbacService, also under the name `RbacService` (the CLI's
 * `--explain-role`, RbacLinkResolver). Roles and assignments: one store each, required. Links: at
 * most one. Rules: at most one in-memory store and one other (design §8.5:
 * `['ConfigRuleStore', 'DbRuleStore']`); none turns rules off.
 * @throws AuthzConfigError, before registering anything, for a store name registerRbacStores
 *   refuses, a missing roles or assignments store, too many stores of a kind, two rule stores of
 *   one sort, or `authz.rbac.rules` with no ConfigRuleStore to read them
 */
export async function registerRbac(container: IContainer, configuration: Pick<Configuration, 'get'>, opts: RegisterRbacOptions = {}): Promise<RegisteredRbac> {
  const count = (kind: RbacStoreKind, min: number, max: number): void => {
    const n = rbacStoreNames(configuration, kind).length;
    if (n > max) throw new AuthzConfigError(`authz.rbac.stores.${kind}: the RBAC model reads ${max === 1 ? 'one store' : `${max} stores at most`}, not ${n}`);
    if (n < min) throw new AuthzConfigError(`authz.rbac.stores.${kind}: the RBAC model needs a store`);
  };
  count('roles', 1, 1);
  count('assignments', 1, 1);
  count('rules', 0, 2);
  count('links', 0, 1);
  count('membership', 0, 1);
  const ruleNames = rbacStoreNames(configuration, 'rules');
  const configRules = configuration.get<unknown>(['authz', 'rbac', 'rules']);
  // Otherwise those rules (restrict, cap, threshold: they only narrow) would be dropped without a word.
  if (Array.isArray(configRules) && configRules.length > 0 && !ruleNames.includes('ConfigRuleStore')) throw new AuthzConfigError(`authz.rbac.rules holds ${configRules.length} rule(s), but authz.rbac.stores.rules (${JSON.stringify(ruleNames)}) does not name ConfigRuleStore, which reads them`);
  // The sort shows on the class (as isSyncRuleStore reads an instance); unknown names are registerRbacStores' to refuse.
  const inMemory = ruleNames
    .map((n) => storeClass(container, n))
    .filter((c) => c !== undefined)
    .map((c) => typeof c.prototype.rulesOn === 'function' && typeof c.prototype.all === 'function');
  if (inMemory.filter((m) => m).length > 1 || inMemory.filter((m) => !m).length > 1) throw new AuthzConfigError(`authz.rbac.stores.rules: one in-memory store and one other at most (ConfigRuleStore, DbRuleStore), not ${JSON.stringify(ruleNames)}`);
  registerRbacStores(container, configuration);

  // Only what registerRbacStores put here: a parent's store must not slip in for a kind the config turned off.
  const store = async <T>(token: Class<T>): Promise<T | undefined> => (container.hasRegistered(token, false) ? ((await container.resolve(token)) as T) : undefined);
  // The chain resolves this container's registrations here; a parent's other rule stores are left out.
  const own = new Set<unknown>(container.Registry.getTypes(RuleStore, false) ?? []);
  const rules = own.size > 0 ? ((await container.resolve(Array.chainOf(RuleStore))) as RuleStore[]).filter((s) => own.has(s.constructor)) : [];
  ruleStoreParts(rules);
  const links = await store(LinkStore);
  // Registered by authz-rbac's storage lane, possibly in a parent container.
  const membership = container.hasRegistered(MembershipStore) ? ((await container.resolve(MembershipStore)) as MembershipStore) : undefined;
  const options: RbacModelOptions = {
    roles: (await store(RoleStore))!,
    assignments: (await store(AssignmentStore))!,
    ...(rules.length > 0 ? { rules: rules.length === 1 ? rules[0] : rules } : {}),
    ...(links ? { links } : {}),
    ...(membership ? { membership } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
  };
  const model = new RbacModel({ ...options, ...(opts.extensions ? { extensions: opts.extensions(options) } : {}) });
  const contributor = new RbacContributor(model);
  const service = new RbacService(model, opts.service);

  container.register(instance(model)).as(AuthorizationModel);
  container.register(instance(contributor)).as(AuthzContributor);
  container.register(instance(service)).as(RbacService);
  container.register(service).asValue(RBAC_SERVICE_NAME);
  return { model, contributor, service, linkResolver: new RbacLinkResolver(service) };
}
