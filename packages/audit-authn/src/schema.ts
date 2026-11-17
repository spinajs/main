import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

export const AUDIT_AUTHN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit.authn.configuration.schema.json',
  $configurationModule: 'audit.authn',
  description: 'Recording of authentication events by @spinajs/audit-authn (audit.authn.*).',
  type: 'object',
  additionalProperties: false,
  properties: {
    // No default: unset means the built-in security trail, which the recorder names itself.
    trail: { type: 'string', minLength: 1, description: "The audit trail authentication events are recorded in (audit.trails.<name>); unset: 'security', which writes to the log with identifiers hashed." },
  },
};

registerConfigurationSchemaAtImport(AUDIT_AUTHN_CONFIGURATION_SCHEMA);
