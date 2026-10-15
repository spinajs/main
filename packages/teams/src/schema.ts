import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const INVITATION_SECRET_MIN_LENGTH = 32;

export const TEAMS_DEFAULTS = Object.freeze({ subTeamsInParent: true, graceDays: 30, defaultTtlHours: 168, subject: 'You are invited to join a team' });

const text = { type: 'string', minLength: 1 };
// propertyNames rejects a typo; additionalProperties: false would let removeAdditional drop it silently.
const closed = (properties: Record<string, unknown>) => ({ type: 'object', default: {}, properties, propertyNames: { enum: Object.keys(properties) } });

export const TEAMS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/teams.configuration.schema.json',
  $configurationModule: 'teams',
  description: 'Teams configuration (teams.*)',
  type: 'object',
  properties: {
    membership: closed({ subTeamsInParent: { type: 'boolean', default: TEAMS_DEFAULTS.subTeamsInParent } }),
    deletion: closed({ graceDays: { type: 'integer', minimum: 0, default: TEAMS_DEFAULTS.graceDays } }),
    invitations: closed({
      // No default: a guessable key would let invitation tokens be forged.
      secret: { type: 'string', minLength: INVITATION_SECRET_MIN_LENGTH },
      template: text,
      subject: { ...text, default: TEAMS_DEFAULTS.subject },
      url: text,
      connection: text,
      defaultTtlHours: { type: 'integer', minimum: 1, default: TEAMS_DEFAULTS.defaultTtlHours },
    }),
  },
};

registerConfigurationSchemaAtImport(TEAMS_CONFIGURATION_SCHEMA);
