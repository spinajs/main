import { AuthzDomains, DefaultAuthzDomains, configuredLineage, readDomainConfig, resolveDelegation } from '@spinajs/authz';
import type { AuthzService, DomainConfig, Principal } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

const ROOT = 'root';

/** The domain's config over its lineage: the host's lineage once it has created its domains, else the configured parents. */
function domainConfig(domain: string): DomainConfig {
  const tree = DI.get(Configuration)?.get<unknown>(['authz']);
  const domains: unknown = DI.get(AuthzDomains);
  const lineage = domains instanceof DefaultAuthzDomains ? domains.lineage(domain) : configuredLineage(tree, domain);
  return readDomainConfig(tree, lineage);
}

/** `engine.maxDelegation` of `domain`, merged over its lineage as the host reads it (default 2). */
export function maxDelegationOf(domain: string = ROOT): number {
  return domainConfig(domain).engine.maxDelegation;
}

/**
 * The principal `relation` and `native:*` ops compile for: `Decision.principal`, the delegate under inherit,
 * which is also the one the engine hands to `RelationResolver.holds`.
 */
export function relationPrincipal(principal: Principal, domain: string = ROOT): Principal {
  return resolveDelegation(principal, undefined, maxDelegationOf(domain)).principal;
}

// The host reads a domain's config once, when its service boots; a new config takes effect with a
// new service instance, so keying by the instance keeps the middleware in step with the engine.
const configs = new WeakMap<AuthzService, DomainConfig>();

/** The booted service's domain config, read once per service instance. */
export function serviceConfig(service: AuthzService): DomainConfig {
  let cfg = configs.get(service);
  if (cfg === undefined) configs.set(service, (cfg = domainConfig(service.domain)));
  return cfg;
}

/** `relationPrincipal` for the domain of a booted service, without reading the config per call. */
export function relationPrincipalOf(principal: Principal, service: AuthzService): Principal {
  return resolveDelegation(principal, undefined, serviceConfig(service).engine.maxDelegation).principal;
}
