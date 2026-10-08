import { BadRequestResponse, ForbiddenResponse, NotFound } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { IdentityRef } from '@spinajs/authn/contracts';

import { NO_STORE } from '../v3/responses.js';
import { bodyField } from '../v3/routes.js';

// The `:uuid` of the credential admin routes and their answers. No answer carries a secret: a reset secret travels in
// the owner's mail only, and an MFA reset hands out nothing (A25, SR-10).

/**
 * users' identities are lower-case uuids (users.Uuid); anything else names no user. Case-sensitive on purpose: under a
 * `_ci` collation an upper-case id finds and expires the user while the session store, keyed by the exact id, revokes
 * nothing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The user the route names, or null for a param that cannot be a user id. */
export const targetOf = (uuid: unknown): IdentityRef | null => (typeof uuid === 'string' && UUID.test(uuid) ? { type: 'user', id: uuid } : null);

/** `sendReset` of the password reset body; true when absent. */
export function sendResetOf(req: Request): boolean | null {
  const value = bodyField(req, 'sendReset');
  if (value === undefined) return true;
  return typeof value === 'boolean' ? value : null;
}

export const invalidSendReset = (): BadRequestResponse => new BadRequestResponse({ error: 'invalid_send_reset', message: 'sendReset must be true or false' }, { Headers: [NO_STORE] });

/** One answer for an id that cannot be a user and for one the guard does not know. */
export const targetNotFound = (): NotFound => new NotFound({ error: 'not_found', message: 'No such user' }, { Headers: [NO_STORE] });

export type GuardRefusal = 'forbidden' | 'protected_role' | 'escalation' | 'not_found';

const REFUSALS: Record<Exclude<GuardRefusal, 'not_found'>, string> = {
  forbidden: 'you may not administer credentials of this user',
  protected_role: 'the user holds a protected role',
  escalation: 'the user holds rights you do not hold',
};

/** 403 with the guard's code, or 404 `not_found`; a code the routes do not know is 403 `forbidden`. */
export function guardRefusal(code: unknown): ForbiddenResponse | NotFound {
  if (code === 'not_found') return targetNotFound();
  const known = typeof code === 'string' && Object.hasOwn(REFUSALS, code) ? (code as keyof typeof REFUSALS) : 'forbidden';
  return new ForbiddenResponse({ error: known, message: REFUSALS[known] }, { Headers: [NO_STORE] });
}
