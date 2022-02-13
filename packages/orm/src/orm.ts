/* eslint-disable prettier/prettier */
import { Configuration } from '@spinajs/configuration';
import { AsyncModule, Autoinject, Container, Class, DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ClassInfo, ListFromFiles } from '@spinajs/reflection';
import * as _ from 'lodash';
import { IDriverOptions, IMigrationDescriptor, OrmMigration, MigrationTransactionMode, IModelDescrtiptor } from './interfaces';
import { ModelBase, MODEL_STATIC_MIXINS, extractModelDescriptor } from './model';
import { MIGRATION_DESCRIPTION_SYMBOL, MODEL_DESCTRIPTION_SYMBOL } from './decorators';
import { OrmDriver } from './driver';
import { InvalidOperation } from '@spinajs/exceptions';
import { DateTime } from 'luxon';
import { OrmException } from './exceptions';

/**
 * Used to exclude sensitive data to others. eg. removed password field from cfg
 */
const CFG_PROPS = ['Database', 'User', 'Host', 'Port', 'Filename', 'Driver', 'Name'];
const MIGRATION_TABLE_NAME = 'spinajs_migration';
const MIGRATION_FILE_REGEXP = /(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})\.(.*)/;
const MIGRATION_TYPE_REGEXP = /(.*)_([0-9]{4}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2}_[0-9]{2})/;

function migrationFileTypeMatcher(name: string) {
  const match = name.match(MIGRATION_TYPE_REGEXP);

  if (match === null || match.length !== 3) {
    throw new OrmException(`Invalid migration file name ${name}, expected: ${name}_YYYY_MM_DD_HH_mm_ss`);
  }

  return match[1];
}

export class Orm extends AsyncModule {
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.models')
  public Models: Array<ClassInfo<ModelBase>>;

  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.migrations', migrationFileTypeMatcher)
  public Migrations: Array<ClassInfo<OrmMigration>>;

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
  public async migrateUp(name?: string): Promise<void> {

    await this.prepareMigrations();

    this.Log.info('DB migration UP started ...');

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

          this.Log.info(`Migration ${migration.constructor.name}:up() success !`);
        };

        if (driver.Options.Migration?.Transaction?.Mode === MigrationTransactionMode.PerMigration) {
          await driver.transaction(trFunction);
        } else {
          await trFunction(driver);
        }
      },
      false,
    );

    this.Log.info('DB migration ended ...');
  }

  /**
   *
   * Migrates schema up ( fill function is not executed )
   *
   * @param name - migration file name
   */
  public async migrateDown(name?: string): Promise<void> {
    await this.prepareMigrations();

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
          const columns = await connection.tableInfo(descriptor.TableName, connection.Options.Database);
          if (columns) {
            m.type[MODEL_DESCTRIPTION_SYMBOL].Columns = _.uniqBy(
              _.map(columns, (c) => {
                return _.assign(c, _.find(descriptor.Columns, { Name: c.Name }));
              }),
              'Name',
            );
          }

          for (const [key, val] of descriptor.Converters) {
            const column = (m.type[MODEL_DESCTRIPTION_SYMBOL] as IModelDescrtiptor).Columns.find((c) => c.Name === key);
            if (column) {
              column.Converter = connection.Container.hasRegistered(val) ? connection.Container.resolve(val) : null;
            }
          }
        }
      }
    }
  }

  public async resolveAsync(): Promise<void> {
    const migrateOnStartup = this.Configuration.get<boolean>('db.Migration.Startup', false);

    await this.createConnections();

    // add all registered migrations via DI
    DI.get<Class<unknown>>(Array.ofType('__migrations___')).forEach((m) => {
      this.registerMigration(m);
    });

    DI.get<Class<unknown>>(Array.ofType('__models__')).forEach((m) => {
      this.registerModel(m);
    });

    if (migrateOnStartup) {
      await this.migrateUp();
    }

    await this.reloadTableInfo();
    this.applyModelMixins();
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
    const date = DateTime.now().toFormat('yyyy_MM_dd_HH_mm_ss');

    this.Migrations.push({
      file: `${migration.name}_${date}.registered`,
      name: `${migration.name}_${date}`,
      type: migration,
    });
  }

  private async createConnections() {
    const connections = await Promise.all(
      this.Configuration.get<IDriverOptions[]>('db.Connections', [])
        .map((c) => {
          if (!this.Container.hasRegistered(c.Driver)) {
            this.Log.warn(`ORM connection driver ${c.Driver} not registerd`);
          }

          this.Log.trace(`Trying to create connection name: ${c.Name}, driver: ${c.Driver}`);
          return this.Container.resolve<OrmDriver>(c.Driver, [c]);
        })
        .filter((c) => c !== null)
        .map((c) => {
          return c.connect().then((d) => {
            this.Log.trace(`Connection succesyfully created ${d.Options.Name}`);
            return d;
          });
        }),
    );

    connections.forEach((c) => {
      this.Connections.set(c.Options.Name, c);
      this.Log.info(`Found ORM driver ${c.Options.Name} with parameters ${JSON.stringify(_.pick(c.Options, CFG_PROPS))}`);
    });

    const defaultConnection = this.Configuration.get<string>('db.DefaultConnection');
    if (defaultConnection) {
      if (!this.Connections.has(defaultConnection)) {
        throw new InvalidOperation(`default connection ${defaultConnection} not exists`);
      }

      this.Connections.set('default', this.Connections.get(defaultConnection));
    }
  }

  private applyModelMixins() {
    this.Models.forEach((m) => {
      // tslint:disable-next-line: forin
      for (const mixin in MODEL_STATIC_MIXINS) {
        m.type[mixin] = (MODEL_STATIC_MIXINS as any)[mixin].bind(m.type);
      }
    });
  }

  private async executeAvaibleMigrations(name: string, callback: (migration: OrmMigration, driver: OrmDriver) => Promise<void>, down: boolean) {
    const toMigrate = name ? this.Migrations.filter((m) => m.name === name) : this.Migrations;

    let migrations = toMigrate
      .map((x) => {
        const match = x.file.match(MIGRATION_FILE_REGEXP);

        if (match === null || match.length !== 4) {
          throw new OrmException(`Migration file name have invalid format ( expected: some_name_yyyy_MM_dd_HH_mm_ss got ${x.file})`);
        }

        const created = DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss');

        if (!created.isValid) {
          throw new OrmException(`Migration file ${x.file} have invalid name format ( invalid migration date )`);
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
      const migrationTableName = cn.Options.Migration?.Table ?? MIGRATION_TABLE_NAME;

      const exists = await cn.select().from(migrationTableName).where({ Migration: m.name }).first();

      if (!exists) {
        const migration = await this.Container.resolve<OrmMigration>(m.type, [cn]);

        this.Log.info(`Setting up migration ${m.name} from file ${m.file} created at ${m.created} mode: ${down ? 'migrate down' : 'migrate up'}`);

        await callback(migration, cn);
      }
    }
  }

  private async prepareMigrations() {
    for (const [_, connection] of this.Connections) {
      const migrationTableName = connection.Options.Migration?.Table ?? MIGRATION_TABLE_NAME;

      let migrationTable = null;

      // if there is no info on migraiton table
      migrationTable = await connection.tableInfo(migrationTableName);

      if (!migrationTable) {
        this.Log.info(`No migration table in database, recreating migration information ...`);

        await connection.schema().createTable(migrationTableName, (table) => {
          table.string('Migration').unique().notNull();
          table.dateTime('CreatedAt').notNull();
        });
      }
    }
  }
}
