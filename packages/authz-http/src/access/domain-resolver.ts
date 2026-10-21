import { DI, Injectable } from '@spinajs/di';
import { AuthzConfigError, AuthzDomains } from '@spinajs/authz';
import { Forbidden } from '@spinajs/exceptions';
import type { Request } from '@spinajs/http';

/** Names the authz domain a request is checked in, for example from a tenant header. */
export abstract class AuthzDomainResolver {
  /** `fallback` is what the route, the controller or the config names today ('root' when nothing does). */
  abstract resolve(req: Request, fallback: string): Promise<string> | string;
}

@Injectable(AuthzDomainResolver)
export class StaticDomainResolver extends AuthzDomainResolver {
  resolve(_req: Request, fallback: string): string {
    return fallback;
  }
}

/** 403 `{ error: 'forbidden', reason: { code: 'unknown_domain' } }`: the resolver named a domain no live domain bears. */
export class UnknownAuthzDomain extends Forbidden {
  public readonly error = 'forbidden';
  public readonly reason = { code: 'unknown_domain' };

  constructor() {
    super('unknown authz domain');
    this.name = new.target.name;
  }
}

// One answer per request and fallback, so the policies of a route and its action agree and the resolver runs once.
const resolved = new WeakMap<Request, Map<string, Promise<string>>>();

/** The domain of `req` as the registered AuthzDomainResolver names it; a name that is not the fallback and that no live domain bears is refused with UnknownAuthzDomain. */
export function resolveAuthzDomain(req: Request, fallback: string): Promise<string> {
  let byFallback = resolved.get(req);
  if (!byFallback) resolved.set(req, (byFallback = new Map()));
  let domain = byFallback.get(fallback);
  if (!domain) byFallback.set(fallback, (domain = lookup(req, fallback)));
  return domain;
}

async function lookup(req: Request, fallback: string): Promise<string> {
  const resolver = await DI.resolve<AuthzDomainResolver>(AuthzDomainResolver);
  const domain: unknown = await resolver.resolve(req, fallback);
  if (typeof domain !== 'string' || domain === '') throw new AuthzConfigError(`${resolver.constructor.name} returned ${JSON.stringify(domain)}, not a domain name`);
  // A fallback that names no domain is a configuration error, which the domain lookup reports.
  if (domain !== fallback && !(await DI.resolve<AuthzDomains>(AuthzDomains)).names().includes(domain)) throw new UnknownAuthzDomain();
  return domain;
}
