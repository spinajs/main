import { AccessControl, User, _unwindGrants } from '@spinajs/rbac';
import type { ISession } from '@spinajs/rbac';
import { resolveSessionContext } from '@spinajs/rbac-http';
import type { IGrantsMap, IUserWithGrants } from '@spinajs/rbac-http';

/**
 * Role whose grants are in effect for a session.
 *
 * Enforcement (see the rbac http middleware) resolves permissions from the
 * session's ActiveRole and falls back to the first assigned role, so anything
 * reported to a client has to resolve it the same way — otherwise the client is
 * told about actions the server will refuse.
 */
export function activeRoleOf(user: User, session?: ISession | null): string | undefined {
  return (session?.Data.get('ActiveRole') as string | undefined) ?? user.Role?.[0];
}

/**
 * Grants in effect for a single role, flattened through its `$extend` chain.
 * An absent role yields an empty map rather than throwing — a user with no role
 * assigned simply has no grants.
 */
export function grantsFor(ac: AccessControl, activeRole: string | undefined): IGrantsMap {
  return (activeRole ? _unwindGrants(activeRole, ac.getGrants()) : {}) as IGrantsMap;
}

/**
 * The login-style user payload: the dehydrated user plus their active role, the
 * grants that role resolves to and whatever the registered SessionContextProviders add.
 *
 * Login, 2FA verification and ending an impersonation all hand the client the
 * same shape, and all three previously assembled it by hand. `Role` is restored
 * explicitly because `dehydrateWithRelations` flattens the relation to a string
 * while clients expect the array they can switch between.
 */
export async function buildUserWithGrants(user: User, activeRole: string | undefined, ac: AccessControl): Promise<IUserWithGrants> {
  return {
    ...(await resolveSessionContext(user, activeRole)),
    ...user.dehydrateWithRelations({ dateTimeFormat: 'iso' }),
    Role: user.Role,
    ActiveRole: activeRole,
    Grants: grantsFor(ac, activeRole),
  } as unknown as IUserWithGrants;
}
