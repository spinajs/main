import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

/** The policy stores `authz.<model>.stores` may name (design §8.3). */
export const ABAC_STORE_NAMES = Object.freeze(['ConfigPolicyStore', 'DbPolicyStore'] as const);
export const ABAC_DEFAULT_STORES: readonly string[] = Object.freeze(['ConfigPolicyStore']);
export const ABAC_DEFAULT_CONNECTION = 'default';
export const ABAC_DEFAULT_SCOPE_RESIDUALS = false;

// Covers the model under its default name only: a model named otherwise reads an unchecked authz.<name>. The model
// checks each policy when it loads it, because it compiles their conditions.
export const AUTHZ_ABAC_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-abac.configuration.schema.json',
  $configurationModule: 'authz.abac',
  description: 'ABAC configuration (authz.abac.*)',
  type: 'object',
  properties: {
    stores: { type: 'array', default: [...ABAC_DEFAULT_STORES], items: { type: 'string', enum: [...ABAC_STORE_NAMES] } },
    policies: { type: 'array', default: [], items: { type: 'object' } },
    connection: { type: 'string', minLength: 1, default: ABAC_DEFAULT_CONNECTION },
    // RFC K1b-1: on a request without id, scope.<type>.* comparisons become residual leaves instead of B19/B39.
    scopeResiduals: { type: 'boolean', default: ABAC_DEFAULT_SCOPE_RESIDUALS },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_ABAC_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AbacConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_ABAC_CONFIGURATION_SCHEMA);
  }
}
