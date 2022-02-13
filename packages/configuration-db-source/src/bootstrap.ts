/* eslint-disable @typescript-eslint/require-await */
import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import CONFIGURATION_SCHEMA from './schemas/configuration.db.source.schema';

@Injectable(Bootstrapper)
export class DbConfigSourceBotstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
    return;
  }
}
