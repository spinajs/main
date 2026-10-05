import type { Configuration } from '@spinajs/configuration';
import { Unauthorized } from '@spinajs/http';
import type { ICookie, IResponseHeader } from '@spinajs/http';
import type { SessionHandle } from '@spinajs/authn/contracts';
import { appEnvOf, clearSessionCookie, sessionCookie } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';

import { AUTHN_FAILURE } from '../policies/v3/errors.js';

/**
 * The 401 body of every authentication failure (A02): login, MFA completion and inline re-authentication, and authn-oidc's
 * callback. It is the body @spinajs/http makes of a thrown authnFailed() in production.
 */
export const AUTHN_FAILURE_BODY: Readonly<{ error: typeof AUTHN_FAILURE; message: string }> = Object.freeze({ error: AUTHN_FAILURE, message: AUTHN_FAILURE.message });

/** Authenticated answers and session cookies must not be cached. */
export const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

/**
 * The 401 answer with AUTHN_FAILURE_BODY. `retryAfterSeconds` (a throttled login, A06) becomes Retry-After; a
 * re-authentication never passes it (N3). `cookies` lets a failed login clear the session it ended.
 */
export function authnFailureResponse(retryAfterSeconds?: number, cookies: readonly ICookie[] = []): Unauthorized {
  const headers: IResponseHeader[] = [NO_STORE];
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)) headers.push({ Name: 'Retry-After', Value: String(Math.max(0, Math.ceil(retryAfterSeconds))) });
  return new Unauthorized({ error: { ...AUTHN_FAILURE_BODY.error }, message: AUTHN_FAILURE_BODY.message }, { Headers: headers, Coockies: [...cookies] });
}

const cookieConfig = (config: Configuration): ISessionCookieConfig => config.get<ISessionCookieConfig>('authn.session.cookie', {}) ?? {};

/**
 * The session cookie for `handle`, for the `Coockies` response option: signed with http.cookie.secret, a
 * browser-session cookie (N8a-D7), with the flags of the app env, an absent env counting as production (SR-16).
 */
export function authnSessionCookie(config: Configuration, handle: SessionHandle): ICookie {
  return sessionCookie(handle.id, cookieConfig(config), undefined, appEnvOf(config)) as ICookie;
}

/** The expired session cookie that clears it in the browser, for the `Coockies` response option. */
export function authnClearedSessionCookie(config: Configuration): ICookie {
  return clearSessionCookie(cookieConfig(config), appEnvOf(config)) as ICookie;
}
