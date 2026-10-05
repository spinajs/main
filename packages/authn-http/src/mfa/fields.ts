import type { IContainer } from '@spinajs/di';
import { Conflict, ForbiddenResponse, Unauthorized } from '@spinajs/http';
import type { Request, Response } from '@spinajs/http';
import { IdentityStore } from '@spinajs/authn/contracts';
import type { Credentials } from '@spinajs/authn/contracts';

import { publishAuthnEvent } from '../policies/v3/audit.js';
import { PASSWORD_HARD_CAP, REAUTH_PASSWORD_FIELD } from '../policies/v3/fresh-auth.js';
import { NO_STORE, authnFailureResponse } from '../v3/responses.js';
import { bodyField, boundedString } from '../v3/routes.js';
import type { Restored } from '../v3/routes.js';

// Body fields and answers of the 3.0 MFA enrolment routes. No answer but the one that hands it out, no error message
// and no event carries a provisioning URI, a recovery code or a password.

/** A step code or a recovery code, capped before TotpService sees it, or null. */
export const codeField = (req: Request): string | null => boundedString(bodyField(req, 'code'), PASSWORD_HARD_CAP);

/**
 * The inline re-authentication of an MFA route (A13): no credentials without `reauthPassword` or for a pending session
 * (TotpService then needs a fresh session), the password credentials of the session's identity, or the login failure
 * answer for a password that can never verify. The field leaves the body, as FreshAuth removes it, and TotpService
 * verifies the credentials only when an active session is not fresh: one check, counted in the reauth throttle.
 */
export async function reauthOf(container: IContainer, req: Request, session: Restored): Promise<{ credentials?: Credentials } | { answer: Response }> {
  const password = bodyField(req, REAUTH_PASSWORD_FIELD);
  if (password !== undefined) {
    delete (req.body as Record<string, unknown>)[REAUTH_PASSWORD_FIELD];
    delete (req as { rawBody?: unknown }).rawBody;
  }
  if (typeof password !== 'string' || password === '') return {};
  let reason = 'password_too_long';
  if (password.length <= PASSWORD_HARD_CAP) {
    if (session.handle.state !== 'active') return {};
    // As assertFreshAuth: IdentityStore.findByLogin takes an email, so display's email names the identity.
    const { email } = await (await container.resolve(IdentityStore)).display(session.identity);
    if (typeof email === 'string' && email !== '') return { credentials: { kind: 'password', login: email, password } };
    reason = 'no_login';
  }
  // Core never sees these attempts, so it cannot audit them.
  const { sessionHandle } = session.facts;
  await publishAuthnEvent(container, req, { type: 'reauth', outcome: 'failure', reason, identity: { type: session.identity.type, id: session.identity.id }, ...(sessionHandle ? { session: sessionHandle } : {}) });
  return { answer: authnFailureResponse() };
}

export type TotpRefusal = 'no_session' | 'not_fresh' | 'enrolled' | 'not_begun' | 'not_enrolled' | 'invalid_code' | 'throttled';

const CONFLICTS: Readonly<Record<string, [string, string]>> = {
  enrolled: ['mfa_enrolled', 'TOTP is already enrolled; disable it first'],
  not_begun: ['mfa_not_begun', 'no TOTP enrolment was begun'],
  not_enrolled: ['mfa_not_enrolled', 'TOTP is not enrolled'],
};

/**
 * The answer to a TotpService refusal. A wrong code and a failed re-authentication give the login failure body (A02);
 * a throttled code check adds Retry-After, as MFA verify does: the mfa throttle keys name the caller's own identity,
 * so the header tells the owner nothing new. A throttled re-authentication sends none (N3): TotpService reports it as
 * `not_fresh`, without retry information.
 */
export function totpRefusal(code: TotpRefusal, o: { reauthTried: boolean; retryAfterSeconds?: number }): Response {
  switch (code) {
    case 'no_session':
      return new Unauthorized({ error: 'unauthenticated', message: 'the session has ended' }, { Headers: [NO_STORE] });
    case 'not_fresh':
      return o.reauthTried ? authnFailureResponse() : new ForbiddenResponse({ error: 'fresh_auth_required', message: 'this route needs a recent login or the password' }, { Headers: [NO_STORE] });
    case 'invalid_code':
      return authnFailureResponse();
    case 'throttled':
      return authnFailureResponse(o.retryAfterSeconds);
    default: {
      const [error, message] = CONFLICTS[code];
      return new Conflict({ error, message }, { Headers: [NO_STORE] });
    }
  }
}
