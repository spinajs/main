import { registerConfigurationSchema, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Bootstrapper, Injectable } from '@spinajs/di';

const name = { type: 'string', minLength: 1 };

export const AUTHZ_QUEUE_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-queue.configuration.schema.json',
  $configurationModule: 'authz.queue',
  description: 'Queue authorization configuration (authz.queue.*)',
  type: 'object',
  properties: {
    // The authz domain whose principal a message carries and whose runAs its handler uses.
    domain: { ...name, default: 'root' },
    // Whether StampedInitiatorPrincipalFactory warns, once, that jobs run from the stamp alone; false for an app that accepts that.
    stampedInitiatorWarning: { type: 'boolean', default: true },
  },
};

// authz.bus belongs to the core schema, which leaves it open; the topic is the queue bus's own key.
export const AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/authz-queue-bus.configuration.schema.json',
  $configurationModule: 'authz.bus',
  description: 'Queue change bus configuration (authz.bus.topic)',
  type: 'object',
  properties: { topic: name },
};

registerConfigurationSchemaAtImport(AUTHZ_QUEUE_CONFIGURATION_SCHEMA);
registerConfigurationSchemaAtImport(AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA);

@Injectable(Bootstrapper)
export class AuthzQueueConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(AUTHZ_QUEUE_CONFIGURATION_SCHEMA);
    registerConfigurationSchema(AUTHZ_BUS_TOPIC_CONFIGURATION_SCHEMA);
  }
}
