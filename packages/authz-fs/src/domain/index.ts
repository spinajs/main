import { AuthorizationModel, AuthzConfigError, AuthzDomains } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import { fsAccessConfigs } from '../config/index.js';
import type { FsAccessConfig } from '../config/index.js';
import { FsInheritModel } from '../inherit/index.js';

export const ROOT_DOMAIN = 'root';

/** Domain containers whose fs models this module registered, or found registered as classes. */
const bootstrapped = new WeakSet<IContainer>();

/**
 * Makes sure the authz domain `domain` exists and holds the fs models (design §13, D11): once per domain container,
 * `AuthzDomains.create(domain)` (its parent from `authz.domains.<domain>.parent`) when the domain is missing, then
 * `FsInheritModel` registered in that container. A domain this module did not create gets the model only when one
 * of its filesystems maps `inherit` and the container holds no FsInheritModel class of its own; a factory
 * registration under the same name is not visible here, so it fails the boot as two models with one name. Root
 * never gets them. Synchronous, so the fs decorator can call it; it must run before the domain's first `service()`.
 */
export function ensureFsDomain(domain: string, container: IContainer = DI.RootContainer): IContainer | undefined {
  if (domain === ROOT_DOMAIN) return undefined;
  const domains = authzDomains(container);
  const created = !domains.names().includes(domain);
  const child = created ? domains.create(domain) : domains.container(domain);
  if (bootstrapped.has(child)) return child;

  const filesystems = domainFilesystems(domain, container);
  const wantsInherit = created || [...filesystems.values()].some((c) => c.inherit !== undefined);
  const ownsInherit = (child.getRegisteredTypes(AuthorizationModel, false) ?? []).some((t) => typeof t === 'function' && t.prototype instanceof FsInheritModel);
  if (wantsInherit && !ownsInherit) {
    // A booted domain never sees later registrations: the inherit mappings would silently grant nothing.
    if (booted(domains, domain)) throw new AuthzConfigError(`authz-fs: authz domain ${JSON.stringify(domain)} booted before the fs models were registered in it; resolve the fs providers before its first AuthzDomains.service()`);
    const model = new FsInheritModel(domain, container);
    child.register(() => model).as(AuthorizationModel);
  }
  bootstrapped.add(child);
  return child;
}

/** The filesystems checked in `domain` (mode other than 'off'), by name. */
export function domainFilesystems(domain: string, container: IContainer = DI.RootContainer): ReadonlyMap<string, FsAccessConfig> {
  return new Map([...fsAccessConfigs(container)].filter(([, c]) => c.mode !== 'off' && c.domain === domain));
}

/**
 * Root never holds the fs models (B29), so `inherit` on a filesystem checked in root would never apply: refused,
 * naming the key.
 */
export function assertFsDomainConfig(fsName: string, config: FsAccessConfig): void {
  if (config.mode === 'off' || config.domain !== ROOT_DOMAIN) return;
  if (config.inherit !== undefined) throw new AuthzConfigError(`authz.fs.${fsName}.inherit needs a domain: the fs-inherit model never runs in root; set authz.fs.${fsName}.domain`);
}

// The AuthzDomains contract cannot tell; the host's DefaultAuthzDomains can (`resolved`), other implementations are trusted.
const booted = (domains: AuthzDomains, name: string): boolean => (domains as { resolved?(n: string): unknown }).resolved?.(name) !== undefined;

function authzDomains(container: IContainer): AuthzDomains {
  const resolved: unknown = container.resolve(AuthzDomains);
  if (!(resolved instanceof AuthzDomains)) throw new AuthzConfigError('authz-fs: AuthzDomains did not resolve synchronously; import the authz host before the fs providers resolve');
  return resolved;
}
