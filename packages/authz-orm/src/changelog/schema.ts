import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const CHANGELOG_RETENTION_DAYS_DEFAULT = 400;

export const AUTHZ_CHANGELOG_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-changelog.configuration.schema.json',
  $configurationModule: 'authz.changelog',
  description: 'Authz changelog configuration (authz.changelog.*)',
  type: 'object',
  properties: {
    // The retention job deletes changes older than this.
    retentionDays: { type: 'integer', minimum: 1, default: CHANGELOG_RETENTION_DAYS_DEFAULT },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_CHANGELOG_CONFIGURATION_SCHEMA);
