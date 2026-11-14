import { CONFIGURATION_SCHEMA } from '@spinajs/configuration';
import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { WORKFLOW_CONFIGURATION_SCHEMA } from './schemas/workflow.configuration.js';

@Injectable(Bootstrapper)
export class WorkflowBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(WORKFLOW_CONFIGURATION_SCHEMA).asValue(CONFIGURATION_SCHEMA.key);
  }
}
