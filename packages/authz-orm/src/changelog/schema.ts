import { Configuration, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

export const CHANGELOG_RETENTION_DAYS_DEFAULT = 400;

export type PolicyVersionMode = 'record' | 'hash' | 'off';
export const POLICY_VERSION_MODE_DEFAULT: PolicyVersionMode = 'record';

export const AUTHZ_CHANGELOG_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-changelog.configuration.schema.json',
  $configurationModule: 'authz.changelog',
  description: 'Authz changelog configuration (authz.changelog.*)',
  type: 'object',
  properties: {
    // The retention job deletes changes older than this.
    retentionDays: { type: 'integer', minimum: 1, default: CHANGELOG_RETENTION_DAYS_DEFAULT },
    // For domains with a decision log: 'record' stores the policy IR in authz_policy_version, 'hash' only cites its hash.
    policyVersion: { type: 'string', enum: ['record', 'hash', 'off'], default: POLICY_VERSION_MODE_DEFAULT },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_CHANGELOG_CONFIGURATION_SCHEMA);

/** `authz.changelog.policyVersion`, the schema default when the configuration has none. */
export function policyVersionMode(): PolicyVersionMode {
  const v = (DI.get(Configuration) as Configuration | undefined)?.get<unknown>(['authz', 'changelog', 'policyVersion']);
  return v === 'hash' || v === 'off' || v === 'record' ? v : POLICY_VERSION_MODE_DEFAULT;
}
