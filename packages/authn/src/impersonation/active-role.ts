import { SessionKeys } from '../contracts/session-state.js';
import type { Session } from '../contracts/session-state.js';
import type { Ceiling } from '../contracts/principal.js';

/** Session data key of the role chosen by a role switch (D14). */
export const ACTIVE_ROLE_KEY = SessionKeys.ActiveRole.name;

/** `ceiling.roles = [ActiveRole]` after a role switch (D14); undefined before any. */
export function activeRoleCeiling(session: Pick<Session, 'activeRole'>): Ceiling | undefined {
  const role = session.activeRole;
  if (role === undefined) return undefined;
  return { roles: role === '' ? [] : [role] };
}
