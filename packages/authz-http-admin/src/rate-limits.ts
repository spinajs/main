import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { configuredRateLimit, rateLimitsSchema } from '@spinajs/http';
import type { RateLimitDefaults } from '@spinajs/http';

/**
 * `authz.http.admin.rateLimit.<name>` defaults. `principal` counts the request's principal; while an admin impersonates
 * a user, that is the user, so an impersonator spends the user's budget.
 */
export const AUTHZ_HTTP_ADMIN_RATE_LIMITS = Object.freeze({
  commands: { limit: 60, windowSeconds: 60, by: 'principal' },
  writes: { limit: 120, windowSeconds: 60, by: 'principal' },
} as const satisfies RateLimitDefaults);

export const AUTHZ_HTTP_ADMIN_RATE_LIMITED_ROUTES = Object.freeze({
  commands: 'POST {basePath}/commands',
  writes: 'the {basePath} write routes (assignments, links, rules, policies, scope attributes)',
});

const { default: _root, ...settings } = rateLimitsSchema(AUTHZ_HTTP_ADMIN_RATE_LIMITS, AUTHZ_HTTP_ADMIN_RATE_LIMITED_ROUTES);

export const AUTHZ_HTTP_ADMIN_RATE_LIMIT_SCHEMA = {
  $id: 'spinajs/authz-http-admin.rate-limit.configuration.schema.json',
  $configurationModule: 'authz.http.admin.rateLimit',
  ...settings,
};

registerConfigurationSchemaAtImport(AUTHZ_HTTP_ADMIN_RATE_LIMIT_SCHEMA);

// DI.clearCache() drops the registration made at import.
@Injectable(Bootstrapper)
export class AuthzHttpAdminConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_HTTP_ADMIN_RATE_LIMIT_SCHEMA);
  }
}

export const AuthzAdminRateLimit = configuredRateLimit('authz.http.admin.rateLimit', AUTHZ_HTTP_ADMIN_RATE_LIMITS);
