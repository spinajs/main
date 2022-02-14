/* eslint-disable security/detect-object-injection */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { InternalLogger } from '@spinajs/internal-logger';
/* eslint-disable prettier/prettier */
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';
import { DI, NewInstance } from '@spinajs/di';
import { IDriverOptions, OrmDriver } from '@spinajs/orm';
import { IConfiguratioDbSourceConfig, IConfigurationEntry } from './types';
import * as _ from 'lodash';
import { DateTime } from 'luxon';

@NewInstance()
export class ConfiguratioDbSource extends ConfigurationSource {
  protected Connection: OrmDriver;

  protected Configuration: Configuration;

  protected Options: IConfiguratioDbSourceConfig;

  public get Order(): number {
    // load as last, we want to have access to
    // connection options
    return 999;
  }

  public async Load(configuration: Configuration): Promise<IConfigLike> {
    this.Configuration = configuration;
    this.Options = this.Configuration.get('configuration-db-source');

    await this.Connect();

    if ((await this.CheckTable()) === false) {
      InternalLogger.warn(`Table for db configuration source not exists. Please run migration before use !`, 'configuration-db-source');
    }

    const dbOptions = (await driver.select().from(options.table)) as IConfigurationEntry[];
    const processed = dbOptions.map((entry) => {
      switch (entry.Type) {
        case 'string':
          return entry;
        case 'int':
          entry.Value = parseInt(entry.Value as string, 10);
          break;
        case 'float':
          entry.Value = parseFloat(entry.Value as string);
          break;
        case 'json':
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          entry.Value = JSON.parse(entry.Value as string);
          break;
        case 'date':
          entry.Value = DateTime.fromFormat(entry.Value as string, 'dd-MM-yyyy');
          break;
        case 'time':
          entry.Value = DateTime.fromFormat(entry.Value as string, 'HH:mm:ss');
          break;
        case 'datetime':
          entry.Value = DateTime.fromISO(entry.Value as string);
          break;
      }
    });

    const grouped = _.groupBy(processed, 'Group');
    const final: IConfigLike = {};
    for (const k in grouped) {
      for (const v of grouped[k]) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        (final[k] as IConfigLike)[v.Slug] = v.Value;
      }
    }

    InternalLogger.success(`Configuration merged`, 'Configuration-db-source');

    return final;
  }

  protected async CheckTable(){
      
  }

  protected async Connect() {
    const dbConnections = this.Configuration.get<IDriverOptions[]>('db.Connections');
    const dbConnection = this.Options.connection === 'default' ? this.Configuration.get<string>('db.DefaultConnection', this.Options.connection) : this.Options.connection;
    const cfgConnectionOptions = dbConnections.find((x) => x.Name === dbConnection);

    if (!cfgConnectionOptions) {
      throw new Error(`Connection for configuration-db-source named ${dbConnection} not exists`);
    }

    InternalLogger.trace(`Using db connection ${dbConnection}`, 'Configuration-db-source');

    // create raw connection to db
    const driver = DI.resolve<OrmDriver>(cfgConnectionOptions.Driver, [cfgConnectionOptions]);
    await driver.connect();
  }
}
