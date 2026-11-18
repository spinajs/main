import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

const KEY_ID = { type: 'string', minLength: 1, maxLength: 64 };
// An HMAC key; a short one would be guessable from one signed message.
const SECRET = { type: 'string', minLength: 16 };

const AUDIT_QUEUE_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/audit-queue.configuration.schema.json',
  $configurationModule: 'audit.queue',
  description: 'Audit queue sink configuration (audit.queue.*)',
  type: 'object',
  properties: {
    // Upper size of one AuditBatchRecorded message; set it under the broker's own limit.
    maxMessageBytes: { type: 'integer', minimum: 1024, default: 200000 },
    signing: {
      type: 'object',
      properties: { keyId: KEY_ID, secret: SECRET },
      required: ['keyId', 'secret'],
      additionalProperties: false,
    },
    verify: {
      type: 'object',
      properties: {
        required: { type: 'boolean' },
        // By source, the keys its batches may be signed with.
        keys: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            minItems: 1,
            items: { type: 'object', properties: { id: KEY_ID, secret: SECRET }, required: ['id', 'secret'], additionalProperties: false },
          },
        },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

registerConfigurationSchemaAtImport(AUDIT_QUEUE_CONFIGURATION_SCHEMA);
