import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const properties = {
  // How long an event must have been visible before it is sealed; covers a transaction that commits a lower seq late.
  settleSeconds: { type: 'number', minimum: 0, default: 30 },
  // Events per seal: the memory of one sealing step and the resolution of a tamper report.
  batchSize: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 },
};

// propertyNames, not additionalProperties: the configuration's removeAdditional would drop a misspelt key silently.
const AUDIT_SEAL_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit-seal.configuration.schema.json',
  $configurationModule: 'audit.seal',
  description: 'Audit sealing configuration (audit.seal.*)',
  type: 'object',
  propertyNames: { enum: Object.keys(properties) },
  properties,
};

registerConfigurationSchemaAtImport(AUDIT_SEAL_CONFIGURATION_SCHEMA);
