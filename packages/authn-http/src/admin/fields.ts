import { BadRequestResponse, ForbiddenResponse, NotFound } from '@spinajs/http';

import { NO_STORE } from '../v3/responses.js';

// Answers of the credential admin routes; dto/credential-admin.ts checks the `:uuid` and the bodies. No answer carries a
// secret: a reset secret travels in the owner's mail only, and an MFA reset hands out nothing (A25, SR-10).

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
