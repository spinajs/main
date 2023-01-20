/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable security/detect-object-injection */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { InternalLogger } from '@spinajs/internal-logger';
/* eslint-disable prettier/prettier */
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';
import { DI, Injectable, Singleton } from '@spinajs/di';
import { IDriverOptions, Orm, OrmDriver } from '@spinajs/orm';
import { IConfiguratioDbSourceConfig, IConfigurationEntry } from './types';
import * as _ from 'lodash';
import { parse } from './models/DbConfig';

@Singleton()
@Injectable(ConfigurationSource)
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
    this.Options = this.Configuration.get('configuration_db_source', {
      connection: 'default',
      table: 'configuration',
    });

    await this.Connect();

    if ((await this.CheckTable()) === false) {
      InternalLogger.warn(`Table for db configuration source not exists. Please run migration before use !`, 'configuration-db-source');
      return null;
    }

    const final = await this.LoadConfigurationFromDB();

    InternalLogger.success(`Configuration merged`, 'Configuration-db-source');

    return final;
  }

  protected async LoadConfigurationFromDB() {
    const dbOptions = await this.Connection.select<IConfigurationEntry[]>().from(this.Options.table);

    dbOptions.forEach((entry) => {
      entry.Value = parse(entry.Value as unknown as string, entry.Type);
    });

    const grouped = _.groupBy(dbOptions, 'Group');
    const final: IConfigLike = {};
    for (const k in grouped) {
      final[k] = {};
      for (const v of grouped[k]) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        (final[k] as IConfigLike)[v.Slug] = v.Value;
      }
    }

    return final;
  }

  protected async CheckTable() {
    return await this.Connection.schema().tableExists(this.Options.table);
  }

  protected async Connect() {
    // we use raw connection instead of ORM,
    // ORM requires configuration module to load first
    const dbConnections = this.Configuration.get<IDriverOptions[]>('db.Connections');
    const dbConnection = this.Options.connection === 'default' ? this.Configuration.get<string>('db.DefaultConnection', this.Options.connection) : this.Options.connection;
    const cfgConnectionOptions = dbConnections.find((x) => x.Name === dbConnection);

    if (!cfgConnectionOptions) {
      throw new Error(`Connection for configuration-db-source named ${dbConnection} not exists`);
    }

    InternalLogger.trace(`Using db connection ${dbConnection}`, 'Configuration-db-source');

    // create or get connection
    if (DI.has(Orm)) {
      this.Connection = DI.get(Orm).Connections.get(dbConnection);
    } else {
      this.Connection = DI.resolve<OrmDriver>(cfgConnectionOptions.Driver, [cfgConnectionOptions]);
      await this.Connection.connect();
    }
  }
}
