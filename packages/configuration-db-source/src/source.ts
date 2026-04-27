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
import { IConfiguratioDbSourceConfig, IConfigurationEntry } from './types.js';
import _ from 'lodash';
import { parse } from './models/DbConfig.js';

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

    try {
      await this.Connect();
    } catch (err) {
      InternalLogger.error(`Failed to connect to database for configuration source (connection: ${this.Options.connection}): ${err instanceof Error ? err.message : String(err)}`, 'configuration-db-source');
      return null;
    }

    if (!this.Connection) {
      InternalLogger.warn(`No database connection available for configuration source (connection: ${this.Options.connection}), skipping db config`, 'configuration-db-source');
      return null;
    }

    let tableExists = false;
    try {
      tableExists = await this.CheckTable();
    } catch (err) {
      InternalLogger.error(`Failed to check if configuration table '${this.Options.table}' exists: ${err instanceof Error ? err.message : String(err)}`, 'configuration-db-source');
      return null;
    }

    if (tableExists === false) {
      InternalLogger.warn(`Table for db configuration source not exists. Please run migration before use !`, 'configuration-db-source');
      return null;
    }

    let dbOptions: IConfigurationEntry[];
    try {
      dbOptions = await this.Connection.select<IConfigurationEntry[]>().from(this.Options.table);
    } catch (err) {
      InternalLogger.error(`Failed to read configuration entries from table '${this.Options.table}': ${err instanceof Error ? err.message : String(err)}`, 'configuration-db-source');
      return null;
    }

    dbOptions.forEach((entry) => {
      entry.Value = parse(entry.Value as unknown as string, entry.Type);
    });

    const final: IConfigLike = {
      onConfigLoad: null,
    };
    dbOptions.forEach((entry) => {
      InternalLogger.trace(`Loaded config ${entry.Slug} from db source`, 'Configuration-db-source');
      _.set(final, entry.Slug, entry.Value);
    });

    InternalLogger.success(`DB configuration loaded`, 'Configuration-db-source');

    return final;
  }



  protected async CheckTable() {
    return await this.Connection.schema().tableExists(this.Options.table);
  }

  protected async Connect() {
    // we use raw connection instead of ORM,
    // ORM requires configuration module to load first
    const dbConnections = this.Configuration.get<IDriverOptions[]>('db.Connections');

    if (!dbConnections) {
      throw new Error(`db.Connections configuration is not set, please check your config files or set proper db connection options`);
    }

    const dbConnection = this.Options.connection === 'default' ? this.Configuration.get<string>('db.DefaultConnection', this.Options.connection) : this.Options.connection;
    const cfgConnectionOptions = dbConnections.find((x) => x.Name === dbConnection);

    if (!cfgConnectionOptions) {
      throw new Error(`Connection for configuration-db-source named ${dbConnection} not exists, please check your default connection name or if ${dbConnection} exists in configuration.`);
    }

    InternalLogger.trace(`Using db connection ${dbConnection}`, 'Configuration-db-source');

    // create or get connection
    if (DI.has(Orm)) {
      this.Connection = DI.get(Orm).Connections.get(dbConnection);

      if (!this.Connection) {
        throw new Error(`ORM is available but connection '${dbConnection}' was not found in ORM connections. Available connections: ${[...DI.get(Orm).Connections.keys()].join(', ') || 'none'}`);
      }

      // verify the existing connection is alive
      try {
        const alive = await this.Connection.ping();
        if (!alive) {
          InternalLogger.warn(`Database connection '${dbConnection}' exists but ping failed, connection may be broken`, 'configuration-db-source');
        }
      } catch (err) {
        InternalLogger.warn(`Database connection '${dbConnection}' ping check failed: ${err instanceof Error ? err.message : String(err)}`, 'configuration-db-source');
      }
    } else {
      if (!DI.check(cfgConnectionOptions.Driver)) {
        throw new Error(`ORM driver '${cfgConnectionOptions.Driver}' is not registered. Make sure the driver package is installed and properly imported.`);
      }

      this.Connection = DI.resolve<OrmDriver>(cfgConnectionOptions.Driver, [cfgConnectionOptions]);

      try {
        await this.Connection.connect();
      } catch (err) {
        InternalLogger.error(
          `Failed to connect to database '${dbConnection}' (driver: ${cfgConnectionOptions.Driver}, host: ${cfgConnectionOptions.Host ?? 'N/A'}, database: ${cfgConnectionOptions.Database ?? cfgConnectionOptions.Filename ?? 'N/A'}): ${err instanceof Error ? err.message : String(err)}`,
          'configuration-db-source',
        );

        // clean up the failed connection
        try {
          await this.Connection.disconnect();
        } catch {
          // ignore cleanup errors
        }
        this.Connection = null;

        throw err;
      }
    }
  }
}
