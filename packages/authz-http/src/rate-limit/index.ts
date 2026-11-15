import { configuredRateLimit } from '@spinajs/http';
import type { RateLimitDefaults } from '@spinajs/http';

/**
 * `authz.http.rateLimit.<name>` defaults. `principal` counts the request's principal (an anonymous one by address);
 * while an admin impersonates a user, that is the user, so an impersonator spends the user's budget.
 */
export const AUTHZ_HTTP_RATE_LIMITS = Object.freeze({
  checks: { limit: 120, windowSeconds: 60, by: 'principal' },
  // Open streams are capped by authz.http.events.maxStreamsPerPrincipal; this caps the reconnect rate.
  events: { limit: 10, windowSeconds: 60, by: 'principal' },
  explain: { limit: 30, windowSeconds: 60, by: 'principal' },
} as const satisfies RateLimitDefaults);

export const AUTHZ_HTTP_RATE_LIMITED_ROUTES = Object.freeze({
  checks: 'POST /user/access/checks',
  events: 'GET /user/access/events',
  explain: 'GET /authz/explain',
});

export const AuthzHttpRateLimit = configuredRateLimit('authz.http.rateLimit', AUTHZ_HTTP_RATE_LIMITS);
