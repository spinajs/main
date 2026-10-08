import { AccessControl, User, _unwindGrants } from '@spinajs/users';
import type { ISession } from '@spinajs/users';
import type { IGrantsMap } from '../../interfaces.js';

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
