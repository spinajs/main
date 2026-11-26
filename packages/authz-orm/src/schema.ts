import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

import { AUTHZ_CHANGELOG_CONFIGURATION_SCHEMA } from './changelog/schema.js';

export const AUTHZ_ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-orm.configuration.schema.json',
  $configurationModule: 'authz.orm',
  description: 'ORM authorization configuration (authz.orm.*)',
  type: 'object',
  properties: {
    // The authz domain whose service plans lists and whose stores a delete cleans up.
    domain: { type: 'string', minLength: 1, default: 'root' },
    // The model property that carries `.withAccess()` answers (design §10.3).
    accessField: { type: 'string', minLength: 1, default: '$access' },
    // Refuse a write of an @AccessResource model's relation columns that no history-keeping WriteObserver takes.
    // null is allowed so that the validator does not coerce it to false: the guard refuses it.
    requireHistory: { type: ['boolean', 'null'], default: false },
    // Row level security (`authz:rls`, Postgres): `session` sets the spina.* settings on every transaction; `bypassRole` is the role SYSTEM connects as.
    rls: {
      type: 'object',
      properties: {
        session: { type: 'boolean', default: false },
        bypassRole: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  // A key this schema does not declare is removed at boot (and reported): a misspelt requireHistory must not read as off in silence.
  additionalProperties: false,
};

registerConfigurationSchemaAtImport(AUTHZ_ORM_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AuthzOrmConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_ORM_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(AUTHZ_CHANGELOG_CONFIGURATION_SCHEMA);
  }
}
