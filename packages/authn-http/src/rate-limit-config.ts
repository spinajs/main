import { rateLimitSchema } from '@spinajs/http';
import type { IRateLimitSettings } from '@spinajs/http';

export { rateLimitSchema };

const ipLimit = (limit: number, windowSeconds: number): Readonly<IRateLimitSettings> => Object.freeze({ limit, windowSeconds, by: 'ip' });

/**
 * The fixed-window limit each anonymous route ships with, per client address (an IPv6 network per
 * `http.throttle.ipv6Prefix`). `authn.http.rateLimit.<name>` overrides it, `false` there takes it off the route.
 */
export const AUTHN_HTTP_RATE_LIMITS = Object.freeze({
  login: ipLimit(30, 60),
  codeLogin: ipLimit(30, 60),
  keysLogin: ipLimit(30, 60),
  passkeysLogin: ipLimit(30, 60),
  keysChallenge: ipLimit(30, 60),
  passkeysChallenge: ipLimit(30, 60),
  codeRequest: ipLimit(10, 600),
  passwordResetRequest: ipLimit(10, 600),
  passwordReset: ipLimit(10, 600),
  verify: ipLimit(20, 600),
  register: ipLimit(10, 3600),
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
  mfaVerify: ipLimit(10, 300),
  mfaChallenge: ipLimit(5, 600),
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
