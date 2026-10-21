import { secretRefSchema } from '@spinajs/authn/schemas';

const stringList = { type: 'array', items: { type: 'string', minLength: 1 } };

/** The authn.local fragment of the authn configuration. */
export const AUTHN_LOCAL_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authn-local.configuration.schema.json',
  $configurationModule: 'authn.local',
  description: 'Local password configuration (authn.local)',
  type: 'object',
  properties: {
    hasher: {
      type: 'object',
      default: {},
      description: 'No argon2 cost keys: the cost is the library default (H30).',
      propertyNames: { enum: ['service', 'maxConcurrent', 'maxQueue'] },
      properties: {
        service: { type: 'string', minLength: 1 },
        maxConcurrent: { type: 'integer', minimum: 1, default: 8, description: 'Argon2 operations at once; the rest queue.' },
        maxQueue: { type: 'integer', minimum: 0, default: 64, description: 'Operations that may wait for a free slot; beyond it a hash or verify fails with HasherBusy.' },
      },
    },
    pepper: {
      ...secretRefSchema('HMAC-SHA256 pepper applied before argon2.', {
        // An empty pepper would add nothing while looking set.
        secret: { type: ['string', 'null'], minLength: 1 },
        version: { type: 'integer', minimum: 1, maximum: 999999999, default: 1, description: 'Stored in the hash prefix so the pepper can rotate.' },
        previous: {
          type: 'array',
          description: 'Older peppers, so a hash made under one still verifies and is rehashed (A03). Each version differs from the others and from `version`.',
          uniqueItemProperties: ['version'],
          items: {
            type: 'object',
            properties: {
              secret: { type: 'string', minLength: 1 },
              // 3/version: up from the item's version (1), the item (2) and the previous list (3) to the pepper's own version.
              version: { type: 'integer', minimum: 1, maximum: 999999999, not: { const: { $data: '3/version' } } },
            },
            required: ['secret', 'version'],
          },
        },
      }),
      default: { secret: null, version: 1 },
    },
    policy: {
      type: 'object',
      default: {},
      properties: {
        minLength: { type: 'integer', minimum: 8, maximum: 128, default: 8, description: 'Passwords are 8–128 characters everywhere (A04).' },
        maxLength: { type: 'integer', minimum: { $data: '1/minLength' }, maximum: 128, default: 128 },
        rule: { type: ['object', 'null'], default: null, description: 'A JSON schema the password must match.' },
        description: { type: 'string' },
        blocklist: { type: ['string', 'null'], default: null, description: 'PasswordBlocklist service.' },
      },
    },
    generator: {
      type: 'object',
      default: {},
      properties: {
        length: { type: 'integer', minimum: 1, default: 16 },
        characters: { ...stringList, minItems: 1, default: ['abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', '0123456789'], description: 'Concatenated into one pool.' },
      },
    },
    reset: {
      type: 'object',
      default: {},
      properties: {
        ttlSeconds: { type: 'integer', minimum: 1, default: 3600 },
        url: { type: 'string', default: '' },
        // Not `type: 'boolean'`: coerceTypes would turn a null into false and keep every API token after a reset.
        revokeTokens: { enum: [true, false], default: true },
      },
    },
    invite: {
      type: 'object',
      default: {},
      properties: {
        ttlSeconds: { type: 'integer', minimum: 1, default: 900 },
      },
    },
    expiration: {
      type: 'object',
      default: {},
      properties: {
        enabled: { type: 'boolean', default: false },
        maxAgeDays: { type: 'number', exclusiveMinimum: 0, default: 31 },
      },
    },
  },
};
