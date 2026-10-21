import type { Configuration } from '@spinajs/configuration';
import '@spinajs/authn-session/register-schema';
import { BadRequestResponse, ForbiddenResponse, HTTP_STATUS_CODE, Ok, Unauthorized } from '@spinajs/http';
import { ActionHookFailed, ActionRefused } from '@spinajs/hooks';
import type { ICookie, IResponseHeader } from '@spinajs/http';
import { AUTHN_FAILURE_BODY } from '@spinajs/authn/contracts';
import type { SessionHandle } from '@spinajs/authn/contracts';
import { appEnvOf, clearSessionCookie, sessionCookie } from '@spinajs/authn-session';
import type { ISessionCookieConfig } from '@spinajs/authn-session';

// Also the body @spinajs/http makes of a thrown authnFailed() in production.
export { AUTHN_FAILURE_BODY };

/** Authenticated answers and session cookies must not be cached. */
export const NO_STORE: IResponseHeader = Object.freeze({ Name: 'Cache-Control', Value: 'no-store' });

/** @spinajs/http has no 202 response. */
export class AcceptedResponse<T = unknown> extends Ok<T> {
  protected _errorCode = HTTP_STATUS_CODE.ACCEPTED;
}

export const badRequest = (error: string, message: string): BadRequestResponse => new BadRequestResponse({ error, message }, { Headers: [NO_STORE] });

/**
 * An action hook's refusal: its code and audit reason (`hook_error` for a hook that failed), and whether `action` itself
 * was refused rather than an action it runs. Null for any other error.
 */
export function hookRefusalOf(err: unknown, action?: string): { code: string; reason: string; own: boolean } | null {
  if (err instanceof ActionRefused) return { code: err.code, reason: `hook:${err.code}`, own: err.action === action };
  if (err instanceof ActionHookFailed) return { code: 'hook_error', reason: 'hook_error', own: err.action === action };
  return null;
}

/** 403 (400 for a refused password or registration) `{ error: 'action_refused', code }`. */
export function hookRefusedAnswer(code: string, status: 400 | 403 = 403): ForbiddenResponse | BadRequestResponse {
  const body = { error: 'action_refused', code, message: 'the action was refused' };
  return status === 400 ? new BadRequestResponse(body, { Headers: [NO_STORE] }) : new ForbiddenResponse(body, { Headers: [NO_STORE] });
}

/** The answer to an action hook's refusal; any other error is rethrown. */
export function refusedByHook(err: unknown, status: 400 | 403 = 403): ForbiddenResponse | BadRequestResponse {
  const refusal = hookRefusalOf(err);
  if (!refusal) throw err;
  return hookRefusedAnswer(refusal.code, status);
}

/** An instant to the second, as the credential tables keep it; null for none. */
export const instant = (d: Date | undefined): string | null => (d ? new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString() : null);

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
