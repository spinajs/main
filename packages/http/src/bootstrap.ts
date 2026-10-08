import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { registerConfigurationSchema } from '@spinajs/configuration';
import { DateTimeHydrator } from './hydrators/DateTimeHydrator.js';
import { DateTime } from 'luxon';
import { HTTP_CONFIGURATION_SCHEMA } from './schemas/http.configuration.js';

@Injectable(Bootstrapper)
export class HttpBootstrapper extends Bootstrapper {
  bootstrap(): void | Promise<void> {
    // register Datetime hydrator at http startup
    const types = DI.getRegisteredTypes(DateTimeHydrator);

    // take last registered
    const dtHydrator = types[types.length - 1];

    // attach to luxon datetime meta
    Reflect.defineMetadata(
      'custom:arg_hydrator',
      {
        hydrator: dtHydrator,
        options: null,
      },
      DateTime,
    );
  }
}

/** Registers the http.* schema, so the configuration validates the merged tree and fills its defaults. */
@Injectable(Bootstrapper)
export class HttpConfigBootstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(HTTP_CONFIGURATION_SCHEMA);
  }
}
