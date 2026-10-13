import { isNonEmptyString } from '@spinajs/util';

import type { Ceiling } from '../contracts/principal.js';

/** Session data key of the role chosen by a role switch (D14). */
export const ACTIVE_ROLE_KEY = 'ActiveRole';

/** `ceiling.roles = [ActiveRole]` after a role switch (D14); undefined before any. */
export function activeRoleCeiling(data: ReadonlyMap<string, unknown>): Ceiling | undefined {
  const role = data.get(ACTIVE_ROLE_KEY);
  if (role === undefined || role === null) return undefined;
  // A value no role switch writes narrows to no role instead of lifting the narrowing.
  return { roles: isNonEmptyString(role) ? [role] : [] };
}
