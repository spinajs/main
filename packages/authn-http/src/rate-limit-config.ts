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
