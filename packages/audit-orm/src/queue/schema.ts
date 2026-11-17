import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const AUDIT_QUEUE_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit-queue.configuration.schema.json',
  $configurationModule: 'audit.queue',
  description: 'Audit queue sink configuration (audit.queue.*)',
  type: 'object',
  properties: {
    // Upper size of one AuditBatchRecorded message; set it under the broker's own limit.
    maxMessageBytes: { type: 'integer', minimum: 1024, default: 200000 },
  },
  additionalProperties: false,
};

registerConfigurationSchemaAtImport(AUDIT_QUEUE_CONFIGURATION_SCHEMA);
