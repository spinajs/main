const AUTHN_FAILURE = Object.freeze({ code: 'E_AUTH_FAILED', message: 'login or password incorrect' });

/** The one 401 body of every authentication failure (A02): login, MFA completion, inline re-authentication and the OIDC callback. */
export const AUTHN_FAILURE_BODY: Readonly<{ error: typeof AUTHN_FAILURE; message: string }> = Object.freeze({ error: AUTHN_FAILURE, message: AUTHN_FAILURE.message });
