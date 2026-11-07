import { RateLimit } from '@spinajs/http';
import type { IRateLimitOptions, IRateLimitSettings } from '@spinajs/http';

export type RateLimitDefaults<N extends string = string> = Readonly<Record<N, Readonly<Required<IRateLimitSettings>>>>;

/** The JSON schema of one `<root>.rateLimit.<name>` entry: settings over `defaults`, or false for no limit. */
export function rateLimitSettingsSchema(defaults: Required<IRateLimitSettings>) {
  return {
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
  };
}

/** The schema of a `rateLimit` object: one entry per route group, an unknown name refused. */
export function rateLimitsSchema(defaults: RateLimitDefaults) {
  return {
    type: 'object',
    default: {},
    propertyNames: { enum: Object.keys(defaults) },
    properties: Object.fromEntries(Object.entries(defaults).map(([name, settings]) => [name, rateLimitSettingsSchema(settings)])),
    description: 'Per-route @RateLimit settings: { limit, windowSeconds, by } over the shipped default, or false for no limit.',
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

export const AuthzHttpRateLimit = configuredRateLimit('authz.http.rateLimit', AUTHZ_HTTP_RATE_LIMITS);
