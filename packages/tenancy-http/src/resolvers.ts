import { Injectable } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { InvalidOption } from '@spinajs/exceptions';
import { TENANCY_DEFAULTS, TenantResolver } from '@spinajs/tenancy';
import type { TenantProposal } from '@spinajs/tenancy';
import { isTenantRequestSource } from './source.js';
import type { TenantRequestSource } from './source.js';

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Where `host` stands to the application's own domains: one of them, one label below one of them, or neither. */
export function hostPlace(host: string, baseDomains: readonly string[]): 'base' | 'other' | { readonly label: string } {
  const bases = baseDomains.map((domain) => domain.toLowerCase());
  // Every base is checked for an exact match first: one base may be a subdomain of another (`www.app` under `app`).
  if (bases.includes(host)) return 'base';
  for (const base of bases) {
    const label = host.endsWith(`.${base}`) ? host.slice(0, -(base.length + 1)) : undefined;
    if (label !== undefined && !label.includes('.')) return { label };
  }
  return 'other';
}

/** A resolver over a `TenantRequestSource`; anything else proposes nothing. */
export abstract class RequestTenantResolver extends TenantResolver {
  public readonly trusted: boolean = true;

  public resolve(source: unknown): TenantProposal | undefined {
    return isTenantRequestSource(source) ? this.propose(source) : undefined;
  }

  protected abstract propose(source: TenantRequestSource): TenantProposal | undefined;
}

/** A host that is neither a base domain nor one label below one is a tenant's own domain. */
@Injectable(TenantResolver)
export class DomainTenantResolver extends RequestTenantResolver {
  @Config('tenancy.http.baseDomains', { defaultValue: TENANCY_DEFAULTS.http.baseDomains })
  protected BaseDomains: readonly string[];

  protected propose({ host }: TenantRequestSource): TenantProposal | undefined {
    // Without the application's own domains every host would be proposed, and no later resolver would be asked.
    if (host === undefined || this.BaseDomains.length === 0) return undefined;
    return hostPlace(host, this.BaseDomains) === 'other' ? { domain: host } : undefined;
  }
}

/** `<slug>.<base domain>`. */
@Injectable(TenantResolver)
export class SubdomainTenantResolver extends RequestTenantResolver {
  @Config('tenancy.http.baseDomains', { defaultValue: TENANCY_DEFAULTS.http.baseDomains })
  protected BaseDomains: readonly string[];

  protected propose({ host }: TenantRequestSource): TenantProposal | undefined {
    const place = host === undefined ? 'other' : hostPlace(host, this.BaseDomains);
    return typeof place === 'object' ? { slug: place.label } : undefined;
  }
}

/** The route parameter `tenancy.http.pathParam`, read as a slug. */
@Injectable(TenantResolver)
export class PathTenantResolver extends RequestTenantResolver {
  @Config('tenancy.http.pathParam', { defaultValue: TENANCY_DEFAULTS.http.pathParam })
  protected Param: string;

  protected propose({ params }: TenantRequestSource): TenantProposal | undefined {
    const slug = textOf(params[this.Param]);
    return slug === undefined ? undefined : { slug };
  }
}

/** The header `tenancy.http.header`, read as a tenant id. Not trusted: a client sets it for any URL. */
@Injectable(TenantResolver)
export class HeaderTenantResolver extends RequestTenantResolver {
  public override readonly trusted: boolean = false;

  @Config('tenancy.http.header', { defaultValue: TENANCY_DEFAULTS.http.header })
  protected Header: string;

  protected propose({ headers }: TenantRequestSource): TenantProposal | undefined {
    const value = headers[this.Header.toLowerCase()];
    return textOf(Array.isArray(value) ? (value as unknown[])[0] : value);
  }
}

/** The attribute `tenancy.http.principalAttribute` of an authenticated principal, read as a tenant id. */
@Injectable(TenantResolver)
export class PrincipalTenantResolver extends RequestTenantResolver {
  @Config('tenancy.http.principalAttribute', { defaultValue: TENANCY_DEFAULTS.http.principalAttribute })
  protected Attribute: string;

  protected propose({ principal }: TenantRequestSource): TenantProposal | undefined {
    return principal?.authenticated === true ? textOf(principal.attributes[this.Attribute]) : undefined;
  }
}

/** The value under `tenancy.http.sessionKey` in the data of the session authn restored, read as a tenant id. */
@Injectable(TenantResolver)
export class SessionTenantResolver extends RequestTenantResolver {
  @Config('tenancy.http.sessionKey', { defaultValue: TENANCY_DEFAULTS.http.sessionKey })
  protected Key: string;

  protected propose({ session }: TenantRequestSource): TenantProposal | undefined {
    return textOf(session?.get(this.Key));
  }
}

/** The resolvers `names` lists, in that order: the entry `x` is the TenantResolver registered as `XTenantResolver`. */
export async function tenantResolvers(names: readonly string[], container: IContainer): Promise<TenantResolver[]> {
  const registered = container.getRegisteredNames(TenantResolver);
  const chain: TenantResolver[] = [];
  for (const name of names) {
    const service = `${name.charAt(0).toUpperCase()}${name.slice(1)}TenantResolver`;
    if (!registered.includes(service)) {
      throw new InvalidOption(`tenancy.http.resolvers "${name}": no TenantResolver is registered as ${service} (registered: ${registered.join(', ') || 'none'})`);
    }
    chain.push(await container.resolveNamed(TenantResolver, service));
  }
  return chain;
}
