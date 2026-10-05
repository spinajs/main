import { AuthenticationFailed, Forbidden, ResourceNotFound } from '@spinajs/exceptions';

/** The body of a failed authentication (A02); a failed inline re-authentication answers it too. */
export const AUTHN_FAILURE = Object.freeze({ code: 'E_AUTH_FAILED', message: 'login or password incorrect' });

// @spinajs/http spreads an error's own enumerable props into the response body: these give { error, message }.

/** 401: no authenticated principal. */
export function unauthenticated(message: string): AuthenticationFailed {
  return Object.assign(new AuthenticationFailed(message), { error: 'unauthenticated' });
}

/** 403: an authenticated caller (or a pending session) that the policy refuses; `code` is stable for clients. */
export function refused(code: string, message: string): Forbidden {
  return Object.assign(new Forbidden(message), { error: code });
}

/** 404 with a stable code. */
export function notFound(code: string, message: string): ResourceNotFound {
  return Object.assign(new ResourceNotFound(message), { error: code });
}

/** 401 with the A02 body. Never carries retry information (N3: no Retry-After on a throttled re-authentication). */
export function authnFailed(): AuthenticationFailed {
  return Object.assign(new AuthenticationFailed(AUTHN_FAILURE.message), { error: AUTHN_FAILURE });
}

/** True for the error authnFailed() makes. */
export const isAuthnFailed = (err: unknown): boolean => err instanceof AuthenticationFailed && (err as { error?: unknown }).error === AUTHN_FAILURE;
