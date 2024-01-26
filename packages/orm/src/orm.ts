import { DatetimeValueConverter } from './interfaces.js';
import { Configuration } from '@spinajs/configuration-common';
import { AsyncService, ClassInfo, Autoinject, Container, Class, DI, IContainer } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import _ from 'lodash';
import { IDriverOptions, IMigrationDescriptor, OrmMigration, MigrationTransactionMode, IModelDescriptor } from './interfaces.js';
import { ModelBase, MODEL_STATIC_MIXINS, extractModelDescriptor } from './model.js';
import { MIGRATION_DESCRIPTION_SYMBOL, MODEL_DESCTRIPTION_SYMBOL } from './decorators.js';
import { OrmDriver } from './driver.js';
import { InvalidOperation } from '@spinajs/exceptions';
import { OrmException } from './exceptions.js';
import { DateTime } from 'luxon';

/**
 * Used to exclude sensitive data to others. eg. removed password field from cfg
 */
const CFG_PROPS = ['Database', 'User', 'Host', 'Port', 'Filename', 'Driver', 'Name'];
const MIGRATION_TABLE_NAME = 'spinajs_migration';
const MIGRATION_FILE_REGEXP = /(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/;

export class Orm extends AsyncService {
  public Models: Array<ClassInfo<ModelBase>> = [];

  public Migrations: Array<ClassInfo<OrmMigration>> = [];

  public Connections: Map<string, OrmDriver> = new Map<string, OrmDriver>();

  @Autoinject()
  public Container: Container;

  @Logger('ORM')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  /**
   *
   * Migrates schema up ( fill function is not executed )
   *
   * @param name - migration file name
   */
  public async migrateUp(name?: string, force: boolean = true): Promise<OrmMigration[]> {
    this.Log.info('DB migration UP started ...');

    const executedMigrations: OrmMigration[] = [];

    await this.executeAvaibleMigrations(
      name,
      async (migration: OrmMigration, driver: OrmDriver) => {
        const trFunction = async (driver: OrmDriver) => {
          await migration.up(driver);

          await driver
            .insert()
            .into(driver.Options.Migration?.Table ?? MIGRATION_TABLE_NAME)
            .values({
              Migration: migration.constructor.name,
              CreatedAt: new Date(),
            });

          executedMigrations.push(migration);

          this.Log.info(`Migration ${migration.constructor.name}:up() success !`);
        };

        if (driver.Options.Migration?.Transaction?.Mode === MigrationTransactionMode.PerMigration) {
          await driver.transaction(trFunction);
        } else {
          await trFunction(driver);
        }
      },
      false,
      force,
    );

    this.Log.info('DB migration ended ...');

    return executedMigrations;
  }

  /**
   *
   * Migrates schema up ( fill function is not executed )
   *
   * @param name - migration file name
   */
  public async migrateDown(name?: string, force: boolean = true): Promise<void> {
    this.Log.info('DB migration DOWN started ...');

    await this.executeAvaibleMigrations(
      name,
      async (migration: OrmMigration, driver: OrmDriver) => {
        const trFunction = async (driver: OrmDriver) => {
          await migration.down(driver);

          await driver
            .del()
            .from(driver.Options.Migration?.Table ?? MIGRATION_TABLE_NAME)
            .where({
              Migration: migration.constructor.name,
            });

          this.Log.info(`Migration down ${migration.constructor.name}:DOWN success !`);
        };

        if (driver.Options.Migration?.Transaction?.Mode === MigrationTransactionMode.PerMigration) {
          await driver.transaction(trFunction);
        } else {
          await trFunction(driver);
        }
      },
      true,
      force,
    );

    this.Log.info('DB migration ended ...');
  }

  /**
   * This function is exposed mainly for unit testing purposes. It reloads table information for models
   * ORM always try to load table at resolve time
   */
  public async reloadTableInfo() {
    for (const m of this.Models) {
      const descriptor = extractModelDescriptor(m.type);
      if (descriptor) {
        const connection = this.Connections.get(descriptor.Connection);
        if (connection) {
          (m.type[MODEL_DESCTRIPTION_SYMBOL] as IModelDescriptor).Driver = connection;
          const columns = await connection.tableInfo(descriptor.TableName, connection.Options.Database);
          if (columns) {
            m.type[MODEL_DESCTRIPTION_SYMBOL].Columns = _.uniqBy(
              _.map(columns, (c) => {
                return _.assign(c, _.find(descriptor.Columns, { Name: c.Name }));
              }),
              'Name',
            );

            //  m.type[MODEL_DESCTRIPTION_SYMBOL].Schema = buildJsonSchema(columns);
          }

          for (const [key, val] of descriptor.Converters) {
            const column = (m.type[MODEL_DESCTRIPTION_SYMBOL] as IModelDescriptor).Columns.find((c) => c.Name === key);
            if (column) {
              column.Converter = connection.Container.hasRegistered(val.Class) ? connection.Container.resolve(val.Class) : null;
            }
          }
        }
      }
    }
  }

  public async resolve(): Promise<void> {
    await this.createConnections();

    // add all registered migrations via DI
    const migrations = DI.getRegisteredTypes<OrmMigration>('__migrations__');
    if (migrations) {
      migrations.forEach((m) => {
        this.registerMigration(m);
      });
    }

    const models = DI.getRegisteredTypes<ModelBase>('__models__');
    if (models) {
      models.forEach((m) => {
        this.registerModel(m);
      });
    }

    const executedMigrations = await this.migrateUp(undefined, false);
    await this.reloadTableInfo();
    this.wireRelations();
    this.applyModelMixins();
    this.registerDefaultConverters();

    for (const m of executedMigrations) {
      this.Log.trace(`Migrating data function for migration ${m.constructor.name} ...`);
      await m.data();
    }
  }

  protected registerDefaultConverters() {
    this.Container.register(DatetimeValueConverter).asMapValue('__orm_db_value_converters__', Date.name);
    this.Container.register(DatetimeValueConverter).asMapValue('__orm_db_value_converters__', DateTime.name);
  }

  protected wireRelations() {
    this.Models.forEach((x) => {
      const desc = extractModelDescriptor(x.type);
      if (!desc) return;

      desc.Relations.forEach((rel) => {
        const found = this.Models.find((y) => {
          const type = _.isString(rel.TargetModelType) ? rel.TargetModelType : rel.TargetModelType.name;
          return y.name === type;
        });

        if (!found) {
          throw new OrmException(`type ${rel.TargetModelType} not found for relation ${rel.Name} in model ${x.name} in file ${x.file}`);
        }

        rel.TargetModel = found.type;
      });
    });
  }

  /**
   *
   * Register model to ORM programatically so ORM can see it and use it. Sometimes dynamical model discovery is not possible eg.
   * in webpack evnironment. In such case we must tell ORM manually what to load.
   *
   * NOTE: use it in ORM constructor before ORM is resolved & model list used.
   *
   * @param model - model to register
   */
  protected registerModel<T extends ModelBase>(model: Class<T>) {
    this.Models.push({
      file: `${model.name}.registered`,
      name: model.name,
      type: model,
    });
  }

  /**
   *
   * Register migration to ORM programatically so ORM can see it and use it. Sometimes dynamical migration discovery is not possible eg.
   * in webpack evnironment. In such case we must tell ORM manually what to load.
   *
   * NOTE: use it in ORM constructor before ORM is resolved & migrate function used.
   *
   * @param model - model to register
   */
  protected registerMigration<T extends OrmMigration>(migration: Class<T>) {
    const created = this.getMigrationDate(migration);

    if (created === null) {
      throw new OrmException(`Migration file ${migration.name} have invalid name format ( invalid migration name,  expected: some_name_yyyy_MM_dd_HH_mm_ss got ${migration.name})`);
    }

    this.Migrations.push({
      file: `${migration.name}.registered`,
      name: `${migration.name}`,
      type: migration,
    });
  }

  private async createConnections() {
    const cConnections = this.Configuration.get<IDriverOptions[]>('db.Connections', []);

    for (const c of cConnections) {
      this.Log.trace(`Trying to create connection name: ${c.Name}, driver: ${c.Driver}`);

      if (!this.Container.hasRegistered(c.Driver)) {
        throw new OrmException(`ORM connection driver ${c.Driver} not registerd`);
      }

      const driver = await this.Container.resolve<OrmDriver>(c.Driver, [c]);
      await driver.connect();

      this.Connections.set(c.Name, driver);
      this.Log.success(`Created ORM connection ${c.Name} with parametes ${JSON.stringify(_.pick(c, CFG_PROPS))}`);
    }

    const defaultConnection = this.Configuration.get<string>('db.DefaultConnection');
    if (defaultConnection) {
      if (!this.Connections.has(defaultConnection)) {
        throw new InvalidOperation(`default connection ${defaultConnection} not exists`);
      }

      this.Connections.set('default', this.Connections.get(defaultConnection));
    }

    // wire connection aliases
    // for example if we have module that uses conn name of db-user-session
    // and we want to wire it to some existinc connection instead creating new one
    const aliases = this.Configuration.get<any>('db.Aliases', {});
    for (const a in aliases) {
      const conn = aliases[a];
      if (!this.Connections.has(conn)) {
        throw new InvalidOperation(`default connection ${conn} not exists`);
      }

      this.Connections.set(a, this.Connections.get(conn));
    }

    // register in container factory func for retrieving db connections
    // it will allow for easy access to it in modules
    DI.register((_container: IContainer, connectionName: string) => {
      if (this.Connections.has(connectionName)) {
        return this.Connections.get(connectionName);
      }

      return null;
    }).as('OrmConnection');
  }

  private applyModelMixins() {
    this.Models.forEach((m) => {
      // tslint:disable-next-line: forin
      for (const mixin in MODEL_STATIC_MIXINS) {
        m.type[mixin] = (MODEL_STATIC_MIXINS as any)[mixin].bind(m.type);
      }
    });
  }

  private getMigrationDate(migration: Class<OrmMigration>) {
    const match = migration.name.match(MIGRATION_FILE_REGEXP);
    if (match === null || match.length !== 3) {
      return null;
    }

    const created = DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss');

    if (!created.isValid) {
      return null;
    }

    return created;
  }

  private async executeAvaibleMigrations(name: string, callback: (migration: OrmMigration, driver: OrmDriver) => Promise<void>, down: boolean, force: boolean) {
    const toMigrate = name ? this.Migrations.filter((m) => m.name === name) : this.Migrations;

    let migrations = toMigrate
      .map((x) => {
        const created = this.getMigrationDate(x.type);

        if (created === null) {
          throw new OrmException(`Migration file ${x.name} have invalid name format ( invalid migration name,  expected: some_name_yyyy_MM_dd_HH_mm_ss got ${x.name})`);
        }

        return {
          created,
          ...x,
        };
      })
      .filter((x) => x !== null)
      .sort((a, b) => {
        if (a.created < b.created) {
          return -1;
        }
        return 1;
      });

    if (down) {
      migrations = migrations.reverse();
    }

    for (const m of migrations) {
      const md = m.type[MIGRATION_DESCRIPTION_SYMBOL] as IMigrationDescriptor;
      const cn = this.Connections.get(md.Connection);

      if (!cn) {
        this.Log.warn(`Connection ${md.Connection} not exists for migration ${m.name} at file ${m.file}`);
        continue;
      }

      const migrationTableName = cn.Options.Migration?.Table ?? MIGRATION_TABLE_NAME;
      if (!cn.Options.Migration?.OnStartup) {
        if (!force) {
          this.Log.warn(`Migration for connection ${md.Connection} is disabled on startup, please check conf file for db.[connection].migration.OnStartup property`);
          continue;
        }
      }

      // if there is no info on migraiton table
      const migrationTableExists = await cn.schema().tableExists(migrationTableName, cn.Options.Database);

      if (!migrationTableExists) {
        this.Log.info(`No migration table in database, recreating migration information ...`);

        await cn.schema().createTable(migrationTableName, (table) => {
          table.string('Migration').unique().notNull();
          table.dateTime('CreatedAt').notNull();
        });
      }

      const exists = await cn.select().from(migrationTableName).where({ Migration: m.name }).orderByDescending('CreatedAt').first();

      if (!exists) {
        const migration = await this.Container.resolve<OrmMigration>(m.type, [cn]);

        this.Log.info(`Setting up migration ${m.name} from file ${m.file} created at ${m.created} mode: ${down ? 'migrate down' : 'migrate up'}`);

        await callback(migration, cn);
      }
    }
  }

  public async dispose(): Promise<void> {
    for (const [, value] of this.Connections) {
      await value.disconnect();
    }
  }
}
