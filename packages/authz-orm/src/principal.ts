import { AuthzConfigError, AuthzDomains, DefaultAuthzDomains, readDomainConfig, resolveDelegation } from '@spinajs/authz';
import type { ConfigGetter, Principal } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

const ROOT = 'root';

/** Domain names from root to `domain`: the host's when it has created its domains, else the configured parents. */
function lineageOf(domain: string, get: ConfigGetter): readonly string[] {
  const domains: unknown = DI.get(AuthzDomains);
  if (domains instanceof DefaultAuthzDomains) return domains.lineage(domain);
  const out = [domain];
  for (let d = domain; d !== ROOT; ) {
    const parent = get(['authz', 'domains', d, 'parent']) ?? ROOT;
    if (typeof parent !== 'string') throw new AuthzConfigError(`authz-orm: authz.domains.${d}.parent must be a string`);
    if (out.includes(parent)) throw new AuthzConfigError(`authz-orm: the parents of authz domain ${JSON.stringify(domain)} form a cycle`);
    out.unshift(parent);
    d = parent;
  }
  return out;
}

/** `engine.maxDelegation` of `domain`, merged over its lineage as the host reads it (default 2). */
export function maxDelegationOf(domain: string = ROOT): number {
  const configuration = DI.get(Configuration) as Configuration | undefined;
  const get: ConfigGetter = (path) => (configuration && typeof configuration.get === 'function' ? configuration.get(path) : undefined);
  return readDomainConfig(get, lineageOf(domain, get)).engine.maxDelegation;
}

/**
 * The principal `relation` and `native:*` ops compile for: `Decision.principal`, the delegate under inherit,
 * which is also the one the engine hands to `RelationResolver.holds`.
 */
export function relationPrincipal(principal: Principal, domain: string = ROOT): Principal {
  return resolveDelegation(principal, undefined, maxDelegationOf(domain)).principal;
}
