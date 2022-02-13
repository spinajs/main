/* eslint-disable @typescript-eslint/require-await */
import { Injectable, Bootstrapper, DI } from '@spinajs/di';
import { ConfiguratioDbSourceInitialMigration } from './migrations/configuration-db-source_2022_02_08_01_13_00';
import { DbConfigurationModel } from './models/DbConfigurationModel';
import CONFIGURATION_SCHEMA from './schemas/configuration.db.source.schema';

@Injectable(Bootstrapper)
export class DbConfigSourceBotstrapper extends Bootstrapper {
  public async bootstrap(): Promise<void> {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
    DI.register(DbConfigurationModel).asValue('__model__');
    DI.register(ConfiguratioDbSourceInitialMigration).asValue('__migration__');
    return;
  }
}
