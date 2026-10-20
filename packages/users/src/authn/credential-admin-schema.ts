import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

/** The permission an actor needs at GLOBAL for the credential admin routes (A25). */
export const CREDENTIAL_ADMIN_PERMISSION_KEY = 'authz.credentials.permission';

export const USERS_CREDENTIAL_ADMIN_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/users-credential-admin.configuration.schema.json',
  $configurationModule: 'authz.credentials',
  description: 'What the credential admin routes require of the actor (authz.credentials.*)',
  type: 'object',
  propertyNames: { enum: ['permission'] },
  properties: {
    permission: { type: 'string', minLength: 1, default: 'users:credentials' },
  },
};

registerConfigurationSchemaAtImport(USERS_CREDENTIAL_ADMIN_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class CredentialAdminConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(USERS_CREDENTIAL_ADMIN_CONFIGURATION_SCHEMA);
  }
}
