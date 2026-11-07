import type { IRateLimitSettings } from '@spinajs/http';

const limit = (limit: number, windowSeconds: number): Readonly<IRateLimitSettings> => Object.freeze({ limit, windowSeconds, by: 'ip' });

/**
 * The fixed-window limit each anonymous route ships with, per client address (an IPv6 network per
 * `http.throttle.ipv6Prefix`). `authn.http.rateLimit.<name>` overrides it, `false` there takes it off the route.
 */
export const AUTHN_HTTP_RATE_LIMITS = Object.freeze({
  login: limit(30, 60),
  codeLogin: limit(30, 60),
  keysLogin: limit(30, 60),
  passkeysLogin: limit(30, 60),
  keysChallenge: limit(30, 60),
  passkeysChallenge: limit(30, 60),
  codeRequest: limit(10, 600),
  passwordResetRequest: limit(10, 600),
  passwordReset: limit(10, 600),
  verify: limit(20, 600),
  register: limit(10, 3600),
});

export type AuthnHttpRateLimitName = keyof typeof AUTHN_HTTP_RATE_LIMITS;

export const AUTHN_HTTP_RATE_LIMITED_ROUTES: Readonly<Record<AuthnHttpRateLimitName, string>> = Object.freeze({
  login: 'POST /auth/login',
  codeLogin: 'POST /auth/code/login',
  keysLogin: 'POST /auth/keys/login',
  passkeysLogin: 'POST /auth/passkeys/login',
  keysChallenge: 'POST /auth/keys/challenge',
  passkeysChallenge: 'POST /auth/passkeys/challenge',
  codeRequest: 'POST /auth/code/request',
  passwordResetRequest: 'POST /auth/password/reset-request',
  passwordReset: 'POST /auth/password/reset',
  verify: 'POST /auth/verify',
  register: 'POST /auth/register',
});

const perPrincipal = (limit: number, windowSeconds: number): Readonly<IRateLimitSettings> => Object.freeze({ limit, windowSeconds, by: 'principal' });

/**
 * The limit each route with a session ships with. The MFA routes of a pending session count the session (its key falls
 * back to the address); the others count the principal, which while an admin impersonates a user is that user, so an
 * impersonator spends the user's budget.
 */
export const AUTHN_HTTP_SESSION_RATE_LIMITS = Object.freeze({
  mfaVerify: limit(10, 300),
  mfaChallenge: limit(5, 600),
  mfaStepUp: perPrincipal(10, 300),
  reauth: perPrincipal(10, 300),
  activeRole: perPrincipal(20, 60),
  impersonate: perPrincipal(10, 600),
  passwordChange: perPrincipal(10, 600),
  verifyRequest: perPrincipal(5, 3600),
  tokens: perPrincipal(20, 600),
  keys: perPrincipal(20, 600),
  passkeys: perPrincipal(20, 600),
  mfaEnrolment: perPrincipal(10, 600),
  adminPasswordReset: perPrincipal(30, 600),
  adminCredentials: perPrincipal(60, 600),
});

export type AuthnHttpSessionRateLimitName = keyof typeof AUTHN_HTTP_SESSION_RATE_LIMITS;

export const AUTHN_HTTP_SESSION_RATE_LIMITED_ROUTES: Readonly<Record<AuthnHttpSessionRateLimitName, string>> = Object.freeze({
  mfaVerify: 'POST /auth/mfa/verify and POST /auth/mfa/recovery',
  mfaChallenge: 'POST /auth/mfa/challenge',
  mfaStepUp: 'POST /auth/mfa/step-up',
  reauth: 'POST /auth/reauth',
  activeRole: 'POST /auth/active-role',
  impersonate: 'POST /auth/impersonate',
  passwordChange: 'PATCH /user/password',
  verifyRequest: 'POST /auth/verify/request',
  tokens: 'POST /user/tokens and POST /user/tokens/:uuid/rotate',
  keys: 'POST /user/keys',
  passkeys: 'POST /user/passkeys/options and POST /user/passkeys',
  mfaEnrolment: 'POST /user/mfa, /user/mfa/confirm, /user/mfa/disable and /user/mfa/recovery-codes',
  adminPasswordReset: 'POST {admin}/:uuid/password-reset',
  adminCredentials: 'POST {admin}/:uuid/mfa-reset, DELETE {admin}/:uuid/sessions and DELETE {admin}/:uuid/tokens',
});

/** The JSON schema of one `*.rateLimit.<name>` key: settings merged over `defaults`, or `false` for no limit. */
export function rateLimitSchema(defaults: Readonly<IRateLimitSettings>, route: string): Record<string, unknown> {
  return {
    default: { ...defaults },
    description: `The limit of ${route}: { limit, windowSeconds, by } merged over the default, or false for none.`,
    anyOf: [
      { enum: [false] },
      {
        type: 'object',
        // propertyNames, not additionalProperties: removeAdditional would drop a misspelt key without a word.
        propertyNames: { enum: ['limit', 'windowSeconds', 'by'] },
        properties: {
          limit: { type: 'integer', minimum: 0 },
          windowSeconds: { type: 'number', exclusiveMinimum: 0 },
          by: { enum: ['ip', 'principal'] },
        },
      },
    ],
  };
}
