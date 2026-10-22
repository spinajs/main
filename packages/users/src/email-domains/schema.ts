import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const SWITCH = { type: 'boolean', default: true };

export const USERS_EMAIL_DOMAINS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/users-email-domains.configuration.schema.json',
  $configurationModule: 'users.emailDomains',
  description: 'Which paths refuse an email address by its domain (users.emailDomains)',
  type: 'object',
  additionalProperties: false,
  properties: {
    apply: {
      type: 'object',
      default: {},
      additionalProperties: false,
      properties: { registration: SWITCH, usersCreate: SWITCH, emailChange: SWITCH },
    },
  },
};

registerConfigurationSchemaAtImport(USERS_EMAIL_DOMAINS_CONFIGURATION_SCHEMA);
