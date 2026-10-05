import { BadRequestResponse, HTTP_STATUS_CODE, Ok } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import type { PasswordViolation } from '@spinajs/authn/contracts';

import { PASSWORD_HARD_CAP } from '../policies/v3/fresh-auth.js';
import { NO_STORE } from '../v3/responses.js';
import { bodyField, boundedString } from '../v3/routes.js';

// Body fields and answers of the 3.0 password routes. Every string is capped at PASSWORD_HARD_CAP before a service sees
// it; no answer and no error message carries a password, a secret or a login.

/** The body of a reset request and of a successful reset, as 2.x answered both. */
export const RESET_ACK: Readonly<{ Ok: true }> = Object.freeze({ Ok: true });

export const resetAck = (): Ok => new Ok({ ...RESET_ACK }, { Headers: [NO_STORE] });

/** The login of a reset request or redemption (2.x `Email`), or null. */
export const loginField = (req: Request): string | null => boundedString(bodyField(req, 'login', 'Email'), PASSWORD_HARD_CAP);

/** The single-use secret of a redemption (2.x `Token`), or null. */
export const secretField = (req: Request): string | null => boundedString(bodyField(req, 'secret', 'Token'), PASSWORD_HARD_CAP);

/** The current password of a change (2.x `OldPassword`), or null. */
export const oldPasswordField = (req: Request): string | null => boundedString(bodyField(req, 'oldPassword', 'OldPassword'), PASSWORD_HARD_CAP);

export const badRequest = (error: string, message: string): BadRequestResponse => new BadRequestResponse({ error, message }, { Headers: [NO_STORE] });

/** 400 with the policy violations; they say nothing about the account. */
export const passwordRejected = (violations: readonly PasswordViolation[]): BadRequestResponse =>
  new BadRequestResponse({ error: 'password_rejected', message: 'the new password does not meet the password policy', violations: [...violations] }, { Headers: [NO_STORE] });

/**
 * The new password (2.x `Password`), checked against the optional confirmation (2.x `ConfirmPassword`), or the 400
 * answer. Longer than PASSWORD_HARD_CAP is the policy's `too_long`, answered without asking the service.
 */
export function newPasswordField(req: Request): { password: string } | { answer: BadRequestResponse } {
  const password = bodyField(req, 'password', 'Password');
  if (typeof password !== 'string' || password === '') return { answer: badRequest('invalid_password', 'password must be a non-empty string') };
  if (password.length > PASSWORD_HARD_CAP) return { answer: passwordRejected(['too_long']) };
  const confirm = bodyField(req, 'confirmPassword', 'ConfirmPassword');
  if (confirm !== undefined && confirm !== password) return { answer: badRequest('password_mismatch', 'the password and its confirmation differ') };
  return { password };
}

/** 429 for a throttled reset request. Its keys are the normalised login and the client ip, whether or not the account exists. */
export function resetRequestThrottled(retryAfterSeconds: number): Ok {
  return new Ok(
    { error: 'throttled', message: 'too many reset requests, try again later' },
    { StatusCode: HTTP_STATUS_CODE.TOO_MANY_REQUESTS, Headers: [NO_STORE, { Name: 'Retry-After', Value: String(Math.max(0, Math.ceil(retryAfterSeconds))) }] },
  );
}
