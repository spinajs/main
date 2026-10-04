import { AuthorizationModel, AuthzConfigError, AuthzContributor } from '@spinajs/authz';
import type { Configuration } from '@spinajs/configuration';
import type { Class, Factory, IContainer } from '@spinajs/di';

import { AssignmentStore, LinkStore, RoleStore, RuleStore } from '../contracts.js';
import type { RbacExtension } from '../model/evaluate.js';
import { RbacContributor } from '../model/contributor.js';
import { RbacLinkResolver } from '../model/links/resolver.js';
import { RbacModel } from '../model/model.js';
import type { RbacModelOptions } from '../model/model.js';
import { RbacService } from '../model/service.js';
import type { RbacServiceOptions } from '../model/service.js';
import { rbacStoreNames } from '../stores/defaults.js';
import type { RbacStoreKind } from '../stores/defaults.js';
import { registerRbacStores } from '../stores/register.js';

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
 * `--explain-role`, RbacLinkResolver). The model reads one store per kind: roles and assignments
 * are required, rules and links optional (an empty list turns them off).
 * @throws AuthzConfigError for a store name registerRbacStores refuses, a missing roles or
 *   assignments store, or more than one store of a kind
 */
export async function registerRbac(container: IContainer, configuration: Pick<Configuration, 'get'>, opts: RegisterRbacOptions = {}): Promise<RegisteredRbac> {
  const one = (kind: RbacStoreKind, required: boolean): void => {
    const count = rbacStoreNames(configuration, kind).length;
    if (count > 1) throw new AuthzConfigError(`authz.rbac.stores.${kind}: the RBAC model reads one store, not ${count}`);
    if (required && count === 0) throw new AuthzConfigError(`authz.rbac.stores.${kind}: the RBAC model needs a store`);
  };
  one('roles', true);
  one('assignments', true);
  one('rules', false);
  one('links', false);
  registerRbacStores(container, configuration);

  // Only what registerRbacStores put here: a parent's store must not slip in for a kind the config turned off.
  const store = async <T>(token: Class<T>): Promise<T | undefined> => (container.hasRegistered(token, false) ? ((await container.resolve(token)) as T) : undefined);
  const rules = await store(RuleStore);
  const links = await store(LinkStore);
  const options: RbacModelOptions = {
    roles: (await store(RoleStore))!,
    assignments: (await store(AssignmentStore))!,
    ...(rules ? { rules } : {}),
    ...(links ? { links } : {}),
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
