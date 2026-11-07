import { RateLimit } from '@spinajs/http';
import { rateLimitSettingsSchema } from '@spinajs/authn-http';

/**
 * `authn.oidc.rateLimit.<name>` defaults of the routes that need a session. `principal` counts the request's principal:
 * while an admin impersonates a user, that is the user, so an impersonator spends the user's budget.
 */
export const AUTHN_OIDC_SESSION_RATE_LIMITS = Object.freeze({
  link: { limit: 10, windowSeconds: 600, by: 'principal' },
  // Each call is an outbound round trip to the provider.
  reauth: { limit: 10, windowSeconds: 300, by: 'principal' },
} as const);

export type AuthnOidcSessionRateLimit = keyof typeof AUTHN_OIDC_SESSION_RATE_LIMITS;

/** The `authn.oidc.rateLimit` entries of the routes that need a session; begin and callback add theirs beside them. */
export const AUTHN_OIDC_SESSION_RATE_LIMIT_SCHEMA: Record<AuthnOidcSessionRateLimit, object> = {
  link: rateLimitSettingsSchema(AUTHN_OIDC_SESSION_RATE_LIMITS.link),
  reauth: rateLimitSettingsSchema(AUTHN_OIDC_SESSION_RATE_LIMITS.reauth),
};

export const OidcSessionRateLimit = (name: AuthnOidcSessionRateLimit) => RateLimit({ config: `authn.oidc.rateLimit.${name}`, default: AUTHN_OIDC_SESSION_RATE_LIMITS[name] });
