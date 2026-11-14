import { Bootstrapper, Injectable } from '@spinajs/di';
import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { configuredRateLimit, rateLimitsSchema } from '@spinajs/http';
import type { RateLimitDefaults } from '@spinajs/http';

/**
 * `teams.http.rateLimit.<name>` defaults. `principal` counts the request's principal; while an admin impersonates a
 * user, that is the user, so an impersonator spends the user's budget.
 */
export const TEAMS_HTTP_RATE_LIMITS = Object.freeze({
  create: { limit: 20, windowSeconds: 3600, by: 'principal' },
  // Each invitation and each resend sends a mail through the app's mailer.
  invite: { limit: 20, windowSeconds: 3600, by: 'principal' },
  // Per principal, not per invitation: the invitation id is client-chosen before the action looks it up, and a key a
  // client picks gets a fresh counter per value.
  resend: { limit: 10, windowSeconds: 3600, by: 'principal' },
  accept: { limit: 10, windowSeconds: 600, by: 'principal' },
} as const satisfies RateLimitDefaults);

export const TEAMS_HTTP_RATE_LIMITED_ROUTES = Object.freeze({
  create: 'POST /teams',
  invite: 'POST /teams/:team/invitations',
  resend: 'POST /teams/:team/invitations/:invitation/resend',
  accept: 'POST /invitations/accept',
});

const { default: _root, ...settings } = rateLimitsSchema(TEAMS_HTTP_RATE_LIMITS, TEAMS_HTTP_RATE_LIMITED_ROUTES);

export const TEAMS_HTTP_RATE_LIMIT_SCHEMA = {
  $id: 'spinajs/teams-http.rate-limit.configuration.schema.json',
  $configurationModule: 'teams.http.rateLimit',
  ...settings,
};

registerConfigurationSchemaAtImport(TEAMS_HTTP_RATE_LIMIT_SCHEMA);

// DI.clearCache() drops the registration made at import.
@Injectable(Bootstrapper)
export class TeamsHttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(TEAMS_HTTP_RATE_LIMIT_SCHEMA);
  }
}

export const TeamsRateLimit = configuredRateLimit('teams.http.rateLimit', TEAMS_HTTP_RATE_LIMITS);
