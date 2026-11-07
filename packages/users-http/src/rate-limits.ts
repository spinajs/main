import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { configuredRateLimit, rateLimitsSchema } from '@spinajs/authz-http';
import type { RateLimitDefaults } from '@spinajs/authz-http';

/**
 * `users.http.rateLimit.<name>` defaults. `principal` counts the request's principal; while an admin impersonates a
 * user, that is the user, so an impersonator spends the user's budget.
 */
export const USERS_HTTP_RATE_LIMITS = Object.freeze({
  create: { limit: 30, windowSeconds: 600, by: 'principal' },
  // Bounds a mass lock-out from a compromised admin session.
  security: { limit: 60, windowSeconds: 600, by: 'principal' },
  list: { limit: 120, windowSeconds: 60, by: 'principal' },
  metadata: { limit: 60, windowSeconds: 60, by: 'principal' },
} as const satisfies RateLimitDefaults);

export const USERS_HTTP_RATE_LIMITED_ROUTES = Object.freeze({
  create: 'POST /users',
  security: 'the /users/security lifecycle routes, DELETE /users/:user and PATCH /users/:uuid/restore',
  list: 'GET /users',
  metadata: 'the /user/metadata and /user/:user/metadata writes',
});

const { default: _root, ...settings } = rateLimitsSchema(USERS_HTTP_RATE_LIMITS, USERS_HTTP_RATE_LIMITED_ROUTES);

export const USERS_HTTP_RATE_LIMIT_SCHEMA = {
  $id: 'spinajs/users-http.rate-limit.configuration.schema.json',
  $configurationModule: 'users.http.rateLimit',
  ...settings,
};

registerConfigurationSchemaAtImport(USERS_HTTP_RATE_LIMIT_SCHEMA);

// DI.clearCache() drops the registration made at import.
@Injectable(Bootstrapper)
export class UsersHttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(USERS_HTTP_RATE_LIMIT_SCHEMA);
  }
}

export const UsersRateLimit = configuredRateLimit('users.http.rateLimit', USERS_HTTP_RATE_LIMITS);
