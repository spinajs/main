import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

export const AUTHZ_WORKFLOW_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-workflow.configuration.schema.json',
  $configurationModule: 'authz.workflow',
  description: 'Workflow signal authorization configuration (authz.workflow.*)',
  type: 'object',
  properties: {
    // The authz domain that decides permissioned signals.
    domain: { type: 'string', minLength: 1, default: 'root' },
    // Whether StampedSignalPrincipalFactory warns, once, that signals are authorized from the stamp alone.
    stampedPrincipalWarning: { type: 'boolean', default: true },
  },
};

registerConfigurationSchemaAtImport(AUTHZ_WORKFLOW_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AuthzWorkflowConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_WORKFLOW_CONFIGURATION_SCHEMA);
  }
}
