import { registerConfigurationSchemaAtImport } from '@spinajs/configuration';

/** What the code uses where the configuration says nothing. */
export const TENANCY_ORM_DEFAULTS = { isolation: 'row', column: 'tenant_id', rls: false } as const;

// Open: the placement keys (maxOpenPlacements, idleCloseMs) belong to the schema-mode plan. No defaults here, the
// registry applies TENANCY_ORM_DEFAULTS. The validator coerces types: `column` lists boolean so that `false` is not
// coerced to a string, and `not` refuses `true`, which `anyOf` would coerce to the valid name "true".
export const TENANCY_ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/tenancy-orm.configuration.schema.json',
  $configurationModule: 'tenancy.orm',
  description: 'Tenant isolation in the ORM (tenancy.orm.*)',
  type: 'object',
  properties: {
    isolation: { enum: ['row', 'schema'] },
    column: { type: ['string', 'boolean'], pattern: '^[A-Za-z_][A-Za-z0-9_]*$', not: { const: true } },
    rls: { type: 'boolean' },
  },
};

registerConfigurationSchemaAtImport(TENANCY_ORM_CONFIGURATION_SCHEMA);
