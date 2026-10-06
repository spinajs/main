import { DI } from '@spinajs/di';
import { AuthzDomains } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';

/** The AuthzService of `domain`: the `authz.queue.domain` its caller reads. */
export async function authzFor(domain: string): Promise<AuthzService> {
  return (await DI.resolve(AuthzDomains)).service(domain);
}
