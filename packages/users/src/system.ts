import { AuthzService, SYSTEM } from '@spinajs/authz';
import { DI } from '@spinajs/di';

/** Runs `fn` as the SYSTEM principal of the root authz domain, so a scoped user model cannot hide a row from users' own lookups. */
export async function runAsSystem<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  const authz = (await DI.resolve(AuthzService)) as AuthzService;
  return authz.runAs(SYSTEM, reason, fn);
}
