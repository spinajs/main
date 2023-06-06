import { Bootstrapper, DI, Injectable } from '@spinajs/di';
import { DateTimeHydrator } from './hydrators/DateTimeHydrator.js';
import { DateTime } from 'luxon';

@Injectable(Bootstrapper)
export class HttpBootstrapper extends Bootstrapper {
  bootstrap(): void | Promise<void> {
    // register Datetime hydrator at http startup
    const types = DI.getRegisteredTypes(DateTimeHydrator);

    // take last registered
    const dtHydrator = types[types.length - 1];

    // attach to datetime meta
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
