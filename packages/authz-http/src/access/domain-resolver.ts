import { Injectable } from '@spinajs/di';
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

/** The domain of `req` as the registered AuthzDomainResolver names it; a name no live domain bears is refused 403 `unknown_domain`. */
export async function resolveAuthzDomain(_req: Request, _fallback: string): Promise<string> {
  throw new Error('not implemented: resolveAuthzDomain');
}
