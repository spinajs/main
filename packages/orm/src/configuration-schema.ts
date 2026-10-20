import { Bootstrapper, DI, Injectable } from '@spinajs/di';

export const ORM_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/orm.configuration.schema.json',
  $configurationModule: 'db',
  description: 'ORM configuration (db.*)',
  type: 'object',
  properties: {
    // enum, not type: 'boolean': coerceTypes would read null and 0 as false and switch the check off
    StrictTableCheck: { enum: [true, false], default: true },
  },
};

// @spinajs/orm depends on configuration-common only, so registerConfigurationSchema() is out of reach.
DI.register(ORM_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');

/** DI.clearCache() drops the value registered at import; a boot that runs the bootstrappers registers it again. */
@Injectable(Bootstrapper)
export class OrmConfigurationBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(ORM_CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}
