import { createHmac } from 'node:crypto';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { RateLimit } from '@spinajs/http';
import type { IMiddlewareContext, IRateLimitOptions, IRateLimitSettings } from '@spinajs/http';

import { tooManyRequests } from '../password/fields.js';

/**
 * `authn.http.rateLimit.<name>` defaults of the routes that need a session. `principal` counts the request's principal:
 * while an admin impersonates a user, that is the user, so an impersonator spends the user's budget.
 */
export const AUTHN_SESSION_RATE_LIMITS = Object.freeze({
  mfaVerify: { limit: 10, windowSeconds: 300, by: 'ip' },
  mfaChallenge: { limit: 5, windowSeconds: 600, by: 'ip' },
  mfaStepUp: { limit: 10, windowSeconds: 300, by: 'principal' },
  reauth: { limit: 10, windowSeconds: 300, by: 'principal' },
  activeRole: { limit: 20, windowSeconds: 60, by: 'principal' },
  impersonate: { limit: 10, windowSeconds: 600, by: 'principal' },
  passwordChange: { limit: 10, windowSeconds: 600, by: 'principal' },
  verifyRequest: { limit: 5, windowSeconds: 3600, by: 'principal' },
  tokens: { limit: 20, windowSeconds: 600, by: 'principal' },
  keys: { limit: 20, windowSeconds: 600, by: 'principal' },
  passkeys: { limit: 20, windowSeconds: 600, by: 'principal' },
  mfaEnrolment: { limit: 10, windowSeconds: 600, by: 'principal' },
  adminPasswordReset: { limit: 30, windowSeconds: 600, by: 'principal' },
  adminCredentials: { limit: 60, windowSeconds: 600, by: 'principal' },
} as const satisfies Record<string, Required<IRateLimitSettings>>);

export type AuthnSessionRateLimit = keyof typeof AUTHN_SESSION_RATE_LIMITS;

/** The JSON schema of one `<package>.rateLimit.<name>` entry, defaulting to `defaults`. */
export const rateLimitSettingsSchema = (defaults: Required<IRateLimitSettings>) => ({
  // const false first: coerceTypes would otherwise try the object branch on it.
  anyOf: [
    { const: false },
    {
      type: 'object',
      // propertyNames, not additionalProperties: false, which removeAdditional would turn into a silent drop of a typo.
      propertyNames: { enum: ['limit', 'windowSeconds', 'by'] },
      properties: { limit: { type: 'integer', minimum: 0 }, windowSeconds: { type: 'number', exclusiveMinimum: 0 }, by: { enum: ['ip', 'principal'] } },
    },
  ],
  default: { ...defaults },
  description: `{ limit, windowSeconds, by } over the default ${defaults.limit} per ${defaults.windowSeconds} s by ${defaults.by}, or false for no limit.`,
});

/** The `authn.http.rateLimit` entries of the routes that need a session; the anonymous routes add theirs beside them. */
export const AUTHN_SESSION_RATE_LIMIT_SCHEMA: Record<AuthnSessionRateLimit, object> = Object.fromEntries(
  Object.entries(AUTHN_SESSION_RATE_LIMITS).map(([name, defaults]) => [name, rateLimitSettingsSchema(defaults)]),
) as Record<AuthnSessionRateLimit, object>;

/**
 * A pending session has no principal, so its MFA routes count the session AuthnMiddleware restored, never a value the
 * client sends: a client that could pick the key would get a fresh counter per request. HMAC under http.cookie.secret
 * (shared by every instance, unlike a per-process key) so the store holds no usable handle. No pending session or no
 * secret: undefined, so the client address counts.
 */
export function pendingSessionKey({ req, storage }: IMiddlewareContext): string | undefined {
  const handle = storage?.AuthnSession?.handle;
  if (handle?.state !== 'pending' || typeof handle.id !== 'string' || handle.id === '') return undefined;
  // cookie-parser puts the configured secret on req.
  const secret = (req as { secret?: unknown } | undefined)?.secret ?? DI.get(Configuration)?.get<string>('http.cookie.secret');
  if (typeof secret !== 'string' || secret === '') return undefined;
  return `session:${createHmac('sha256', secret).update(handle.id).digest('base64url')}`;
}

/** authn's own 429 body, as a throttled verification or reset request answers. */
export const throttledRequest = (retryAfterSeconds: number) => tooManyRequests('too many requests, try again later', retryAfterSeconds);

/** `@RateLimit` on `authn.http.rateLimit.<name>`; the answer is authn's 429 unless `options` names another. */
export function SessionRateLimit(name: AuthnSessionRateLimit, options: Pick<IRateLimitOptions, 'answer' | 'headers' | 'key'> = {}) {
  return RateLimit({ config: `authn.http.rateLimit.${name}`, default: AUTHN_SESSION_RATE_LIMITS[name], answer: throttledRequest, ...options });
}
