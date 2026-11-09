import { RateLimit, rateLimitSchema } from '@spinajs/http';
import type { IRateLimitOptions, RateLimitDefault } from '@spinajs/http';

export type RateLimitDefaults<N extends string = string> = Readonly<Record<N, RateLimitDefault>>;

/** The schema of a `rateLimit` object: one `rateLimitSchema` entry per route group, an unknown name refused. */
export function rateLimitsSchema<N extends string>(defaults: RateLimitDefaults<N>, routes: Readonly<Record<N, string>>) {
  return {
    type: 'object',
    default: {},
    propertyNames: { enum: Object.keys(defaults) },
    properties: Object.fromEntries((Object.keys(defaults) as N[]).map((name) => [name, rateLimitSchema(defaults[name], routes[name])])),
    description: 'Per-route @RateLimit settings: { limit, windowSeconds, by, headers } over the shipped default, or false for no limit.',
  };
}

/** A `@RateLimit` factory over `<root>.<name>` config keys with `defaults` for each name. */
export function configuredRateLimit<N extends string>(root: string, defaults: RateLimitDefaults<N>) {
  return (name: N, options: Pick<IRateLimitOptions, 'answer' | 'headers' | 'key'> = {}) => RateLimit({ config: `${root}.${name}`, default: defaults[name], ...options });
}

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
