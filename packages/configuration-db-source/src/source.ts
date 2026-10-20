/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable security/detect-object-injection */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { InternalLogger } from '@spinajs/internal-logger';
/* eslint-disable prettier/prettier */
import { Configuration, ConfigurationSource, IConfigLike } from '@spinajs/configuration-common';
import { Autoinject, DI, Injectable, Singleton } from '@spinajs/di';
import { IDriverOptions, Orm, OrmDriver } from '@spinajs/orm';
import { IConfiguratioDbSourceConfig, IConfigurationEntry } from './types.js';
import _ from 'lodash';
import { DbConfigValueConverter } from './converter.js';

@Singleton()
@Injectable(ConfigurationSource)
export class ConfiguratioDbSource extends ConfigurationSource {
  protected Connection!: OrmDriver;

  protected Configuration!: Configuration;

  protected Options!: IConfiguratioDbSourceConfig;

  /** True when `Connect()` opened a driver connection of its own instead of borrowing the ORM's. */
  protected OwnsConnection = false;

  @Autoinject(DbConfigValueConverter)
  protected Converter!: DbConfigValueConverter;

  public get Order(): number {
    // load as last, we want to have access to
    // connection options
    return 999;
  }

  public async Load(configuration: Configuration): Promise<IConfigLike> {
    this.Configuration = configuration;
    // schema defaults are applied only after all sources ran, so a partial object must be completed here
    this.Options = {
      connection: 'default',
      table: 'configuration',
      ..._.omitBy(this.Configuration.get<Partial<IConfiguratioDbSourceConfig>>('configuration_db_source', {}), _.isUndefined),
    };

    try {
      await this.Connect();
    } catch (err) {
      InternalLogger.error({ error: err, connection: this.Options.connection }, 'Failed to connect to database for configuration source (connection: ${connection})', 'configuration-db-source');
      return {}  as IConfigLike;
    }

    if (!this.Connection) {
      InternalLogger.warn({ connection: this.Options.connection }, 'No database connection available for configuration source (connection: ${connection}), skipping db config', 'configuration-db-source');
      return {}  as IConfigLike;
    }

    try {
      return await this.LoadEntries();
    } finally {
      if (this.OwnsConnection) {
        try {
          await this.Connection.disconnect();
        } catch (err) {
          InternalLogger.warn({ error: err, connection: this.Options.connection }, 'Failed to close configuration source connection ${connection}', 'configuration-db-source');
        }
      }
    }
  }

  protected async LoadEntries(): Promise<IConfigLike> {
    let tableExists = false;
    try {
      tableExists = await this.CheckTable();
    } catch (err) {
      InternalLogger.error({ error: err, table: this.Options.table }, 'Failed to check if configuration table ${table} exists', 'configuration-db-source');
      return {}  as IConfigLike;
    }

    if (tableExists === false) {
      InternalLogger.warn(`Table for db configuration source not exists. Please run migration before use !`, 'configuration-db-source');
      return {}  as IConfigLike;
    }

    let dbOptions: IConfigurationEntry[];
    try {
      dbOptions = await this.Connection.select<IConfigurationEntry[]>().from(this.Options.table);
    } catch (err) {
      InternalLogger.error({ error: err, table: this.Options.table }, 'Failed to read configuration entries from table ${table}', 'configuration-db-source');
      return {}  as IConfigLike;
    }

    // only load rows that are actually exposed for runtime use. We filter in
    // memory instead of in SQL to stay driver-agnostic about how booleans are
    // stored.
    dbOptions = dbOptions.filter((entry) => Boolean((entry as unknown as { Exposed: unknown }).Exposed));

    // the source reads raw rows (it deliberately avoids the ORM model), so we
    // convert each value with the same converter the model uses, keyed off the
    // row's `Type` column.
    dbOptions.forEach((entry) => {
      entry.Value = this.Converter.fromDB(entry.Value as unknown as string, entry, { TypeColumn: 'Type' });
    });

    const final: IConfigLike = {} as IConfigLike;
    dbOptions.forEach((entry) => {
      InternalLogger.trace({ slug: entry.Slug }, 'Loaded config ${slug} from db source', 'Configuration-db-source');
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

    InternalLogger.trace({ connection: dbConnection }, 'Using db connection ${connection}', 'Configuration-db-source');

    this.OwnsConnection = false;

    // create or get connection
    if (DI.has(Orm)) {
      this.Connection = DI.get(Orm)!.Connections.get(dbConnection)!;

      if (!this.Connection) {
        throw new Error(`ORM is available but connection '${dbConnection}' was not found in ORM connections. Available connections: ${[...DI.get(Orm)!.Connections.keys()].join(', ') || 'none'}`);
      }

      // verify the existing connection is alive
      try {
        const alive = await this.Connection.ping();
        if (!alive) {
          InternalLogger.warn({ connection: dbConnection }, 'Database connection ${connection} exists but ping failed, connection may be broken', 'configuration-db-source');
        }
      } catch (err) {
        InternalLogger.warn({ error: err, connection: dbConnection }, 'Database connection ${connection} ping check failed', 'configuration-db-source');
      }
    } else {
      if (!DI.check(cfgConnectionOptions.Driver)) {
        throw new Error(`ORM driver '${cfgConnectionOptions.Driver}' is not registered. Make sure the driver package is installed and properly imported.`);
      }

      this.Connection = DI.resolve<OrmDriver>(cfgConnectionOptions.Driver, [cfgConnectionOptions]);
      this.OwnsConnection = true;

      try {
        await this.Connection.connect();
      } catch (err) {
        InternalLogger.error(
          { error: err, connection: dbConnection, driver: cfgConnectionOptions.Driver, host: cfgConnectionOptions.Host, database: cfgConnectionOptions.Database ?? cfgConnectionOptions.Filename },
          'Failed to connect to database ${connection} (driver: ${driver}${?host}, host: ${host}${/host}${?database}, database: ${database}${/database})',
          'configuration-db-source',
        );

        // clean up the failed connection
        try {
          await this.Connection.disconnect();
        } catch {
          // ignore cleanup errors
        }

        throw err;
      }
    }
  }
}
