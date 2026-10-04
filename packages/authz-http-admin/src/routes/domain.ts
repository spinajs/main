import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthzConfigError, AuthzDomains, AuthzService } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';

/** `authz.http.admin.domain`, read on each call: the domain whose AuthzAdmin the routes use (default root). */
export function adminDomain(): string {
  const configuration = DI.get(Configuration);
  const value = configuration?.get<unknown>(['authz', 'http', 'admin', 'domain']);
  if (value === undefined) return 'root';
  if (typeof value !== 'string' || value === '') throw new AuthzConfigError(`authz.http.admin.domain must be a non-empty string, got ${JSON.stringify(value)}`);
  return value;
}

/** The AuthzAdmin of the configured domain. */
export async function domainAdmin(): Promise<AuthzAdmin> {
  const domain = adminDomain();
  if (domain === 'root') return ((await DI.resolve(AuthzService)) as AuthzService).admin();
  const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
  return (await domains.service(domain)).admin();
}
