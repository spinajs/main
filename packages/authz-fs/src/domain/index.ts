import { AuthorizationModel, AuthzConfigError, AuthzContributor, AuthzDomains } from '@spinajs/authz';
import type { AuthzContribution, ModelInitContext, PermissionDef, Policy, ResourceType } from '@spinajs/authz';
import { AbacModel, ConfigPolicyStore } from '@spinajs/authz-abac';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { fsAccessConfigs } from '../access-config/index.js';
import type { FsAccessConfig } from '../access-config/index.js';
import { FsInheritModel } from '../inherit/index.js';

export const ROOT_DOMAIN = 'root';

export const FS_ABAC_MODEL = 'fs-abac';

/** Domain containers whose fs models this module registered, or found registered as classes. */
const bootstrapped = new WeakSet<IContainer>();

/**
 * Makes sure the authz domain `domain` exists and holds the fs models (design §13, D11), once per domain container:
 * `AuthzDomains.create(domain)` (its parent from `authz.domains.<domain>.parent`) when the domain is missing, then in
 * that container `FsInheritModel` (`fs-inherit`) when a filesystem of the domain maps `inherit`, and an `AbacModel`
 * named `fs-abac` over the union of their `policies` with its contributor when one has policies.
 *
 * `fs-inherit` is not added over an FsInheritModel class the container registers itself. A factory registration
 * of a model with one of these names is not visible here; it fails the boot as two models with one name. Root never
 * gets them. Synchronous, so the fs decorator can call it; it must run before the domain's first `service()`.
 */
export function ensureFsDomain(domain: string, container: IContainer = DI.RootContainer): IContainer | undefined {
  if (domain === ROOT_DOMAIN) return undefined;
  const domains = authzDomains(container);
  const known = domains.names().includes(domain);
  if (known && bootstrapped.has(domains.container(domain))) return domains.container(domain);

  const filesystems = domainFilesystems(domain, container);
  const { policies, owners } = domainPolicies(filesystems);
  const child = known ? domains.container(domain) : domains.create(domain);
  const ownsInherit = (child.getRegisteredTypes(AuthorizationModel, false) ?? []).some((t) => t === FsInheritModel || (typeof t === 'function' && t.prototype instanceof FsInheritModel));
  const inherit = !ownsInherit && [...filesystems.values()].some((c) => c.inherit !== undefined);
  // A booted domain never sees later registrations: the mappings and policies would silently not apply.
  if ((inherit || policies.length > 0) && booted(domains, domain)) {
    throw new AuthzConfigError(`authz-fs: authz domain ${JSON.stringify(domain)} booted before the fs models were registered in it; resolve the fs providers before its first AuthzDomains.service()`);
  }
  if (inherit) {
    const model = new FsInheritModel(domain, container);
    child.register(() => model).as(AuthorizationModel);
  }
  if (policies.length > 0) {
    const model = new FsAbacModel(policies, owners);
    const contributor = new FsAbacContributor(model, owners);
    child.register(() => model).as(AuthorizationModel);
    child.register(() => contributor).as(AuthzContributor);
  }
  bootstrapped.add(child);
  return child;
}

/** `filesystem key, policy "<id>"` for a policy id, so a boot error points at the config entry. */
type Owners = ReadonlyMap<string, string>;

const keyOf = (owners: Owners, id: string): string | undefined => {
  const fs = owners.get(id);
  return fs === undefined ? undefined : `authz.fs.${fs}.policies`;
};

/** `fs-abac`: an AbacModel whose load and routing errors name the `authz.fs.<name>.policies` keys of the policies they mention. */
class FsAbacModel extends AbacModel {
  constructor(policies: readonly Policy[], private readonly owners: Owners) {
    super({ name: FS_ABAC_MODEL, stores: [new ConfigPolicyStore(policies)] });
  }

  async init(ctx: ModelInitContext): Promise<void> {
    try {
      await super.init(ctx);
    } catch (e) {
      throw this.located(e);
    }
  }

  applies(permission: PermissionDef, type: ResourceType): boolean {
    try {
      return super.applies(permission, type);
    } catch (e) {
      throw this.located(e);
    }
  }

  private located(e: unknown): unknown {
    if (!(e instanceof AuthzConfigError)) return e;
    const keys = [...new Set([...this.owners.keys()].filter((id) => e.message.includes(JSON.stringify(id))).map((id) => keyOf(this.owners, id)!))];
    return keys.length === 0 ? e : new AuthzConfigError(`${keys.join(', ')}: ${e.message}`, { cause: e });
  }
}

/** AbacContributor with each ref's source naming the `authz.fs.<name>.policies` key of its policy. */
class FsAbacContributor extends AuthzContributor {
  constructor(private readonly model: AbacModel, private readonly owners: Owners) {
    super();
  }

  contribute(): AuthzContribution {
    const out = this.model.contribution();
    const source = (s: string): string => {
      const m = /policy ("(?:[^"\\]|\\.)*")$/.exec(s);
      const id = m ? (JSON.parse(m[1]) as string) : undefined;
      const key = id === undefined ? undefined : keyOf(this.owners, id);
      return key === undefined ? s : `${key}, policy ${m![1]}`;
    };
    return {
      ...out,
      ...(out.permissionRefs ? { permissionRefs: out.permissionRefs.map((r) => ({ ...r, source: source(r.source) })) } : {}),
      ...(out.scopeRefs ? { scopeRefs: out.scopeRefs.map((r) => ({ ...r, source: source(r.source) })) } : {}),
    };
  }
}

/** The filesystems checked in `domain` (mode other than 'off'), by name. */
export function domainFilesystems(domain: string, container: IContainer = DI.RootContainer): ReadonlyMap<string, FsAccessConfig> {
  return new Map([...fsAccessConfigs(container)].filter(([, c]) => c.mode !== 'off' && c.domain === domain));
}

/** The union of the filesystems' policies; one id in two filesystems is refused (AbacModel refuses one used twice in a list). */
function domainPolicies(filesystems: ReadonlyMap<string, FsAccessConfig>): { readonly policies: readonly Policy[]; readonly owners: Owners } {
  const owners = new Map<string, string>();
  const policies: Policy[] = [];
  for (const [name, config] of filesystems) {
    for (const policy of config.policies ?? []) {
      const id: unknown = policy.id;
      const first = typeof id === 'string' ? owners.get(id) : undefined;
      if (first !== undefined && first !== name) throw new AuthzConfigError(`authz.fs.${first}.policies and authz.fs.${name}.policies both hold a policy with id ${JSON.stringify(id)}; ids must be unique within the domain ${JSON.stringify(config.domain)}`);
      if (typeof id === 'string') owners.set(id, name);
      policies.push(policy);
    }
  }
  return { policies, owners };
}

/**
 * Root never holds the fs models (B29), so `inherit` or `policies` on a filesystem checked in root would never
 * apply: refused, naming the key.
 */
export function assertFsDomainConfig(fsName: string, config: FsAccessConfig): void {
  if (config.mode === 'off' || config.domain !== ROOT_DOMAIN) return;
  if (config.inherit !== undefined) throw new AuthzConfigError(`authz.fs.${fsName}.inherit needs a domain: the fs-inherit model never runs in root; set authz.fs.${fsName}.domain`);
  if (config.policies !== undefined) throw new AuthzConfigError(`authz.fs.${fsName}.policies needs a domain: the fs-abac model never runs in root; set authz.fs.${fsName}.domain, or put root-wide policies in authz.abac.policies`);
}

// The AuthzDomains contract cannot tell; the host's DefaultAuthzDomains can (`resolved`), other implementations are trusted.
const booted = (domains: AuthzDomains, name: string): boolean => (domains as { resolved?(n: string): unknown }).resolved?.(name) !== undefined;

function authzDomains(container: IContainer): AuthzDomains {
  const resolved: unknown = container.resolve(AuthzDomains);
  if (!(resolved instanceof AuthzDomains)) throw new AuthzConfigError('authz-fs: AuthzDomains did not resolve synchronously; import the authz host before the fs providers resolve');
  return resolved;
}
