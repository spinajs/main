const stringList = { type: 'array', items: { type: 'string' } };

const combineEntry = {
  type: 'object',
  properties: {
    algorithm: { type: 'string', minLength: 1 },
    models: stringList,
  },
  required: ['algorithm'],
};

const combine = {
  type: 'object',
  properties: {
    default: combineEntry,
    types: { type: 'object', additionalProperties: combineEntry },
  },
  required: ['default'],
};

const permissions = {
  type: 'object',
  additionalProperties: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      fields: { type: 'boolean' },
      types: stringList,
      implies: stringList,
    },
  },
};

const engine = {
  type: 'object',
  properties: {
    explain: { type: 'boolean' },
    modelTimeoutMs: { type: 'integer', minimum: 1 },
    maxDelegation: { type: 'integer', minimum: 0 },
  },
};

const fields = {
  type: 'object',
  properties: {
    neverRead: stringList,
    write: { type: 'object', properties: { mode: { type: 'string', enum: ['strip', 'reject'] } } },
  },
};

const cache = {
  type: 'object',
  properties: {
    maxEntries: { type: 'integer', minimum: 0 },
    ttlSeconds: { type: 'number', minimum: 0 },
  },
};

const audit = {
  type: 'object',
  properties: {
    denials: { type: 'boolean' },
    runAs: { type: 'boolean' },
    unscoped: { type: 'boolean' },
    service: { type: 'string', minLength: 1 },
  },
};

// The root object stays open: sections such as authz.http or authz.rbac belong to other packages
// and the configuration's removeAdditional would strip them.
// No `default` keywords: defaults live in AUTHZ_DEFAULTS, so a config without `authz` behaves the same.
export const AUTHZ_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz.configuration.schema.json',
  $configurationModule: 'authz',
  description: 'Authorization configuration (authz.*)',
  type: 'object',
  properties: {
    permissions,
    combine,
    domains: {
      type: 'object',
      propertyNames: { pattern: '^[A-Za-z0-9_.-]{1,64}$', not: { const: 'root' } },
      additionalProperties: {
        type: 'object',
        properties: {
          parent: { type: 'string' },
          combine,
          disable: stringList,
          permissions,
          engine,
          fields,
          cache,
          audit,
        },
      },
    },
    principals: {
      type: 'object',
      properties: {
        anonymous: { type: 'object', properties: { enabled: { type: 'boolean' } } },
        roleSwitch: { type: 'object', properties: { requirePassword: stringList } },
      },
    },
    fields,
    engine,
    cache,
    audit,
    bus: { type: 'object', properties: { service: { type: 'string', minLength: 1 } } },
    config: { type: 'object', properties: { rejectLegacyKeys: { type: 'boolean' } } },
  },
};
