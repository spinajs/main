import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { TENANT_STATES } from './contracts.js';
import { TENANT_ID_PATTERN } from './scope.js';

/** What the code uses where the configuration says nothing. */
export const TENANCY_DEFAULTS = {
  registry: 'ConfigTenantRegistry',
  access: 'PrincipalAttributeTenantAccess',
  registryCacheMs: 5000,
  http: {
    resolvers: ['domain', 'subdomain', 'path', 'header', 'principal', 'session'],
    header: 'x-tenant',
    unknownTenant: 404,
    baseDomains: [],
    pathParam: 'tenant',
    principalAttribute: 'tenant',
    sessionKey: 'tenant',
  },
} as const;

const text = { type: 'string', minLength: 1 };
const texts = { type: 'array', items: text };

// Open at the root and inside `http`: tenancy.orm, tenancy.config and later sections belong to the packages that read them.
export const TENANCY_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/tenancy.configuration.schema.json',
  $configurationModule: 'tenancy',
  description: 'Tenancy configuration (tenancy.*)',
  type: 'object',
  properties: {
    registry: text,
    access: text,
    registryCacheMs: { type: 'integer', minimum: 0 },
    tenants: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: TENANT_ID_PATTERN },
          slug: text,
          name: text,
          state: { enum: [...TENANT_STATES] },
          domains: texts,
          placement: {
            type: 'object',
            required: ['kind', 'schema'],
            additionalProperties: false,
            properties: { kind: { const: 'schema' }, schema: text },
          },
          settings: { type: 'object' },
        },
      },
    },
    http: {
      type: 'object',
      properties: {
        resolvers: texts,
        header: text,
        unknownTenant: { enum: [404, 403] },
        baseDomains: texts,
        pathParam: text,
        principalAttribute: text,
        sessionKey: text,
      },
    },
  },
};

registerConfigurationSchemaAtImport(TENANCY_CONFIGURATION_SCHEMA);
