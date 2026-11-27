import { AuthzDomains, AuthzService, ROOT_DOMAIN } from '@spinajs/authz';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

/** The domain authz-orm keeps the ancestors in (`authz.orm.domain`, default root): the tenant parents live there. */
export async function tenancyAuthz(): Promise<AuthzService> {
  const domain = DI.get(Configuration)?.get<unknown>(['authz', 'orm', 'domain']);
  if (typeof domain !== 'string' || domain === '' || domain === ROOT_DOMAIN) return await DI.resolve<AuthzService>(AuthzService);
  return (await DI.resolve(AuthzDomains)).service(domain);
}
