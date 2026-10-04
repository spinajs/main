import { DI } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { AuthzDomains } from '@spinajs/authz';
import type { AuthzService } from '@spinajs/authz';

/** The authz domain of the queue integration (`authz.queue.domain`, default `root`). */
export async function authzFor(domain?: string): Promise<AuthzService> {
  const name = domain ?? DI.get(Configuration)?.get<string>(['authz', 'queue', 'domain'], 'root') ?? 'root';
  return (await DI.resolve(AuthzDomains)).service(name);
}
