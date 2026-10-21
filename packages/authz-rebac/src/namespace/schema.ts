import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

/** The tuple stores `authz.<model>.store` may name. */
export const REBAC_STORE_NAMES = Object.freeze(['DbTupleStore', 'MemoryTupleStore'] as const);
export const REBAC_DEFAULT_STORE = 'DbTupleStore';
export const REBAC_DEFAULT_LIMITS = Object.freeze({ maxDepth: 8, maxCalls: 10_000 });

const name = { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]*$' };

const rewrite = {
  description: "A rewrite: 'relation', 'tupleset->relation', or { computed } | { tupleToUserset } | { union } | { intersection } | { exclusion }",
  oneOf: [
    { type: 'string', minLength: 1 },
    { type: 'object', required: ['computed'], additionalProperties: false, properties: { computed: name } },
    { type: 'object', required: ['tupleToUserset'], additionalProperties: false, properties: { tupleToUserset: { type: 'object', required: ['tupleset', 'computed'], additionalProperties: false, properties: { tupleset: name, computed: name } } } },
    { type: 'object', required: ['union'], additionalProperties: false, properties: { union: { type: 'array', minItems: 1 } } },
    { type: 'object', required: ['intersection'], additionalProperties: false, properties: { intersection: { type: 'array', minItems: 1 } } },
    { type: 'object', required: ['exclusion'], additionalProperties: false, properties: { exclusion: { type: 'object', required: ['base', 'subtract'], additionalProperties: false, properties: { base: {}, subtract: {} } } } },
  ],
};

// Covers the model under its default name only; the model checks the namespaces again when it compiles them.
export const AUTHZ_REBAC_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-rebac.configuration.schema.json',
  $configurationModule: 'authz.rebac',
  description: 'ReBAC configuration (authz.rebac.*)',
  type: 'object',
  properties: {
    store: { type: 'string', enum: [...REBAC_STORE_NAMES], default: REBAC_DEFAULT_STORE },
    limit: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxDepth: { type: 'integer', minimum: 1, default: REBAC_DEFAULT_LIMITS.maxDepth },
        maxCalls: { type: 'integer', minimum: 1, default: REBAC_DEFAULT_LIMITS.maxCalls },
      },
    },
    namespaces: {
      type: 'object',
      default: {},
      propertyNames: name,
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        properties: {
          relations: { type: 'object', propertyNames: name, additionalProperties: { type: 'array', items: { type: 'string', minLength: 1 } } },
          permissions: { type: 'object', propertyNames: name, additionalProperties: rewrite },
        },
      },
    },
    permissions: { type: 'object', default: {}, additionalProperties: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_.-]*#[A-Za-z_][A-Za-z0-9_.-]*$' } },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_REBAC_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class RebacConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_REBAC_CONFIGURATION_SCHEMA);
  }
}
