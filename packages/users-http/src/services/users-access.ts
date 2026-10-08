import { AuthzService, SYSTEM } from '@spinajs/authz';
import type { Decision, Permission, Principal, ResourceRef } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { Forbidden, ResourceNotFound } from '@spinajs/exceptions';
import type { User } from '@spinajs/users';

const USERS = 'users';

async function check(principal: Principal, permission: Permission, resource: ResourceRef, subject?: User): Promise<Decision> {
  const authz = (await DI.resolve(AuthzService)) as AuthzService;
  return authz.check({ principal, permission, resource, ...(subject ? { subject } : {}) });
}

const isTrue = (d: Decision) => d.allowed === true && d.residual.op === 'true';

/**
 * Refuses unless the caller holds `permission` on every user. For the routes that cannot be decided on one existing row
 * (the list, create) or that change an account's standing (restore, the lifecycle routes): a conditional grant, such as
 * `self`, does not reach them.
 */
export async function requireEveryUser(principal: Principal, permission: Permission): Promise<void> {
  if (!isTrue(await check(principal, permission, { type: USERS }))) {
    throw new Forbidden(`${permission} here needs a grant on every user, not a conditional one`);
  }
}

/**
 * The row `lookup` finds (run as SYSTEM: the application's user model may be scoped), once the caller may apply
 * `permission` to it. `@Access` decides the `users` type only; a conditional decision there is decided again on the row,
 * as the caller. For such a caller a missing row answers 403 like a refused one, so it cannot probe for accounts.
 */
export async function userRowFor(principal: Principal, permission: Permission, lookup: () => Promise<User | undefined | null>): Promise<User> {
  const typeLevel = await check(principal, permission, { type: USERS });
  if (!typeLevel.allowed) {
    throw new Forbidden(`no ${permission}`);
  }

  const authz = (await DI.resolve(AuthzService)) as AuthzService;
  const row = (await authz.runAs(SYSTEM, 'users-http-admin-row', lookup)) ?? undefined;
  const unconditional = isTrue(typeLevel);

  if (!row) {
    throw unconditional ? new ResourceNotFound('User not found') : new Forbidden(`${permission} is not granted on this user`);
  }

  if (!unconditional && !isTrue(await check(principal, permission, { type: USERS, id: row.Uuid }, row))) {
    throw new Forbidden(`${permission} is not granted on this user`);
  }

  return row;
}
