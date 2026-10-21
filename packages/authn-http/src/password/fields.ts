import { BadRequestResponse, HTTP_STATUS_CODE, Ok } from '@spinajs/http';
import type { PasswordViolation } from '@spinajs/authn/contracts';

import { PASSWORD_HARD_CAP } from '../policies/v3/fresh-auth.js';
import type { InputAnswer } from '../validation/answers.js';
import { NO_STORE, badRequest } from '../v3/responses.js';

// Answers of the 3.0 password routes. The DTOs cap every string at PASSWORD_HARD_CAP before a service sees it; no
// answer and no error message carries a password, a secret or a login.

/** The body of a reset request and of a successful reset. */
export const RESET_ACK: Readonly<{ Ok: true }> = Object.freeze({ Ok: true });

export const resetAck = (): Ok => new Ok({ ...RESET_ACK }, { Headers: [NO_STORE] });

/** 400 `invalid_login`: no login, or one longer than any account has. */
export const invalidLogin = (): BadRequestResponse => badRequest('invalid_login', `login must be a non-empty string of at most ${PASSWORD_HARD_CAP} characters`);

/** 400 with the policy violations; they say nothing about the account. */
export const passwordRejected = (violations: readonly PasswordViolation[]): BadRequestResponse =>
  new BadRequestResponse({ error: 'password_rejected', message: 'the new password does not meet the password policy', violations: [...violations] }, { Headers: [NO_STORE] });

export const passwordMismatch = (): BadRequestResponse => badRequest('password_mismatch', 'the password and its confirmation differ');

/** A refused new `password`: one over PASSWORD_HARD_CAP breaks the policy's `too_long`, anything else is no password. */
export const newPasswordRefused: InputAnswer = (input) => (input.rules.get('password') === 'maxLength' ? passwordRejected(['too_long']) : badRequest('invalid_password', 'password must be a non-empty string'));

/** The answer to a `confirmPassword` that differs from `password`, or null. */
export const mismatchOf = (body: { readonly password: string; readonly confirmPassword?: string }): BadRequestResponse | null =>
  body.confirmPassword !== undefined && body.confirmPassword !== body.password ? passwordMismatch() : null;

/** @spinajs/http has no 429 response; like its ForbiddenResponse, a client error over the badRequest template. */
export class TooManyRequestsResponse<T = unknown> extends BadRequestResponse<T> {
  protected _errorCode = HTTP_STATUS_CODE.TOO_MANY_REQUESTS;
}

/** 429 `{ error: 'throttled', message }` with Retry-After and no-store. */
export const tooManyRequests = (message: string, retryAfterSeconds: number): TooManyRequestsResponse =>
  new TooManyRequestsResponse({ error: 'throttled', message }, { Headers: [NO_STORE, { Name: 'Retry-After', Value: String(Math.max(0, Math.ceil(retryAfterSeconds))) }] });

/** 429 for a throttled reset request. Its keys are the normalised login and the client ip, whether or not the account exists. */
export const resetRequestThrottled = (retryAfterSeconds: number): TooManyRequestsResponse => tooManyRequests('too many reset requests, try again later', retryAfterSeconds);
