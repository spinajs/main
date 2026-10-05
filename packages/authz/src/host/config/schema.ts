import { AUTHZ_DEFAULTS } from './defaults.js';

const D = AUTHZ_DEFAULTS;

const stringList = { type: 'array', items: { type: 'string' } };

/** What AuthzDomains.create accepts as a domain name. */
const DOMAIN_NAME = '^[A-Za-z0-9_.-]{1,64}$';

// A default only at the root: inside authz.domains.<n> an unset key must stay unset, or the domain would stop inheriting it from its parent.
const rootDefault = (root: boolean, value: unknown): { default?: unknown } => (root ? { default: value } : {});

const combineEntry = {
  type: 'object',
  properties: {
    algorithm: { type: 'string', minLength: 1 },
    models: stringList,
  },
  required: ['algorithm'],
};

const combine = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, D.combine),
  properties: {
    default: combineEntry,
    types: { type: 'object', additionalProperties: combineEntry },
  },
  required: ['default'],
});

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

const engine = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, {}),
  properties: {
    explain: { type: 'boolean', ...rootDefault(root, D.engine.explain) },
    modelTimeoutMs: { type: 'integer', minimum: 1, ...rootDefault(root, D.engine.modelTimeoutMs) },
    maxDelegation: { type: 'integer', minimum: 0, ...rootDefault(root, D.engine.maxDelegation) },
  },
});

const fields = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, {}),
  properties: {
    neverRead: { ...stringList, ...rootDefault(root, D.fields.neverRead) },
    write: {
      type: 'object',
      ...rootDefault(root, {}),
      properties: { mode: { type: 'string', enum: ['strip', 'reject'], ...rootDefault(root, D.fields.write.mode) } },
    },
  },
});

const cache = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, {}),
  properties: {
    maxEntries: { type: 'integer', minimum: 0, ...rootDefault(root, D.cache.maxEntries) },
    ttlSeconds: { type: 'number', minimum: 0, ...rootDefault(root, D.cache.ttlSeconds) },
  },
});

const audit = (root: boolean) => ({
  type: 'object',
  ...rootDefault(root, {}),
  properties: {
    denials: { type: 'boolean', ...rootDefault(root, D.audit.denials) },
    runAs: { type: 'boolean', ...rootDefault(root, D.audit.runAs) },
    unscoped: { type: 'boolean', ...rootDefault(root, D.audit.unscoped) },
    service: { type: 'string', minLength: 1 },
  },
});

// The root object stays open: sections such as authz.http or authz.rbac belong to other packages
// and the configuration's removeAdditional would strip them.
export const AUTHZ_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz.configuration.schema.json',
  $configurationModule: 'authz',
  description: 'Authorization configuration (authz.*)',
  type: 'object',
  properties: {
    permissions,
    combine: combine(true),
    domains: {
      type: 'object',
      propertyNames: { pattern: DOMAIN_NAME, not: { const: 'root' } },
      additionalProperties: {
        type: 'object',
        properties: {
          parent: { type: 'string', pattern: DOMAIN_NAME },
          combine: combine(false),
          disable: stringList,
          permissions,
          engine: engine(false),
          fields: fields(false),
          cache: cache(false),
          audit: audit(false),
        },
      },
    },
    principals: {
      type: 'object',
      properties: {
        // No default: the deprecated 2.x guest factory reads this key with its own false default, 3.x readers fall back to true.
        anonymous: { type: 'object', properties: { enabled: { type: 'boolean' } } },
        roleSwitch: { type: 'object', properties: { requirePassword: stringList } },
      },
    },
    fields: fields(true),
    engine: engine(true),
    cache: cache(true),
    audit: audit(true),
    bus: { type: 'object', properties: { service: { type: 'string', minLength: 1 } } },
    config: { type: 'object', default: {}, properties: { rejectLegacyKeys: { type: 'boolean', default: D.config.rejectLegacyKeys } } },
  },
};
