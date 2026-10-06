import { DI } from '@spinajs/di';
import { AuthzDomains, AuthzService } from '@spinajs/authz';
import type { AuthzAdmin } from '@spinajs/authz';

/** The AuthzAdmin of `domain`, the `authz.http.admin.domain` the admin routes read. */
export async function domainAdmin(domain: string): Promise<AuthzAdmin> {
  if (domain === 'root') return ((await DI.resolve(AuthzService)) as AuthzService).admin();
  const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
  return (await domains.service(domain)).admin();
}
