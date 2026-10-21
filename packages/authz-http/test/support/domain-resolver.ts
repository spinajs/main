import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import type { Request } from '@spinajs/http';

import { AuthzDomainResolver } from '../../src/index.js';

/** Header `x-tenant` names the domain; it records every fallback it was asked about. */
export class TenantResolver extends AuthzDomainResolver {
  public static readonly fallbacks: string[] = [];

  public resolve(req: Request, fallback: string): string {
    TenantResolver.fallbacks.push(fallback);
    const tenant = req.headers['x-tenant'];
    return typeof tenant === 'string' && tenant !== '' ? tenant : fallback;
  }
}

/** Registers `TenantResolver` as the AuthzDomainResolver; the returned function removes it. */
export function registerTenantResolver(): () => void {
  TenantResolver.fallbacks.length = 0;
  DI.register(TenantResolver).as(AuthzDomainResolver);
  DI.uncache(AuthzDomainResolver);
  return () => {
    DI.unregister(TenantResolver as Class<unknown>);
    DI.uncache(TenantResolver);
    DI.uncache(AuthzDomainResolver);
  };
}
