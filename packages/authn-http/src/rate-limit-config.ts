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
