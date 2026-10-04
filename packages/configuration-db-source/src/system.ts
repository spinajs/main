import { DI } from '@spinajs/di';
import { AuthzDomains, AuthzService, SYSTEM } from '@spinajs/authz';

export const POLL_REASON = 'config-poll';

/**
 * Runs `fn` as SYSTEM in the AuthzService of `domain` when one is registered, directly otherwise.
 * Query builders are thenables, hence PromiseLike.
 */
export async function asSystem<T>(fn: () => PromiseLike<T>, domain = 'root'): Promise<T> {
  if (DI.getRegisteredTypes(AuthzService).length === 0) {
    return fn();
  }

  const service = domain === 'root' ? await DI.resolve(AuthzService) : await (await DI.resolve(AuthzDomains)).service(domain);
  return service.runAs(SYSTEM, POLL_REASON, async () => fn());
}
