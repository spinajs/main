import { BooleanValueConverter, DatetimeValueConverter, IValueConverter, TimeValueConverter } from './interfaces.js';
import { Configuration } from '@spinajs/configuration-common';
import { AsyncService, ClassInfo, Autoinject, Container, Class, DI, IContainer } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import _ from 'lodash';
import { IDriverOptions, OrmMigration } from './interfaces.js';
import { ModelBase, MODEL_STATIC_MIXINS, updateModelDescriptor } from './model.js';
import { OrmDriver } from './driver.js';
import { InvalidOperation } from '@spinajs/exceptions';
import { OrmException } from './exceptions.js';
import { DateTime } from 'luxon';
import { extractModelDescriptor } from './descriptor.js';
import { buildModelJsonSchema } from './schema.js';
import { TimeSpan } from '@spinajs/util';
import { MIGRATION_FILE_REGEXP, MigrationRunner } from './migration-runner.js';

/**
 * Used to exclude sensitive data to others. eg. removed password field from cfg
 */
const CFG_PROPS = ['Database', 'User', 'Host', 'Port', 'Filename', 'Driver', 'Name'];

/**
 * What `DI.resolve(Orm, [ ... ])` hands the Orm at construction - the same way a driver is
 * handed its `IDriverOptions`. Not configuration: nothing here comes from a config file, because
 * the one thing it controls has to be a property of THIS PROCESS rather than of the deployment.
 */
export interface IOrmOptions {
  /**
   * Run the boot migration pass - `Migration.up(undefined, { force: false })` and the `data()`
   * phase that seeds whatever it applied? Defaults to true, and an ordinary application never
   * passes it: leaving it out is what keeps `db.Connections[n].Migration.OnStartup` meaning what
   * it says.
   *
   * `false` is for a process whose job is to operate ON the migrations - `@spinajs/orm-cli`
   * passes it. Such a process needs everything else resolve() does ( connections, models,
   * converters, `orm.Migration` ) but must not have the schema move underneath it as a side
   * effect of booting: a boot pass that meets a FAILED row takes down even the command invoked
   * to clear that row, and a boot pass that succeeds turns `migrate-status` from a report into a
   * migration.
   *
   * It is deliberately not a `force` variation. `force` chooses whether the `OnStartup` gate is
   * honoured, and both of its values RUN migrations - `force: false` runs every connection whose
   * gate is on, which is exactly the set a migration tool must not touch on its way in.
   */
  MigrateOnStartup?: boolean;
}

export class Orm extends AsyncService {
  public Models: Array<ClassInfo<ModelBase>> = [];

  public Migrations: Array<ClassInfo<OrmMigration>> = [];

  public Connections: Map<string, OrmDriver> = new Map<string, OrmDriver>();

  /**
   * Everything migration-related: `up`, `down`, `status`, `resolve`. Assigned in `resolve()`,
   * once the connections it dispatches to exist - so it is only usable on a resolved Orm.
   */
  public Migration: MigrationRunner;

  @Autoinject()
  public Container: Container;

  @Logger('ORM')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  /**
   * `DI.resolve(Orm)` leaves this empty, which is every application: the defaults are the
   * documented behaviour and nothing has to opt into them.
   */
  constructor(protected Options: IOrmOptions = {}) {
    super();
  }

  /**
   * This function is exposed mainly for unit testing purposes. It reloads table information for models
   * ORM always try to load table at resolve time
   */
  public async reloadTableInfo() {
    for (const m of this.Models) {
      const descriptor = extractModelDescriptor(m.type);
      if (descriptor) {
        const connection = this.Connections.get(descriptor.Connection!);

        if (!connection) {
          this.Log.warn(`Cannot find connection ${descriptor.Connection} in connection list (model ${descriptor.Name})`);
          continue;
        }

        const converters = connection.Container.get<Map<string, any>>('__orm_db_value_converters__');

        updateModelDescriptor(m.type, (d) => {
          d.Driver = connection;
        });

        const columns = await connection.tableInfo(descriptor.TableName, connection.Options.Database);
        if (columns) {
          updateModelDescriptor(m.type, (d) => {
            d.Columns = _.unionBy(
              d.Columns,
              _.uniqBy(
                columns.map((c) => {
                  // Only assign properties from table column that are not undefined
                  const existingColumn = _.find(descriptor.Columns, { Name: c.Name });
                  if (existingColumn) {
                    // Merge only defined properties from table info
                    Object.keys(c).forEach(key => {
                      const columnKey = key as keyof typeof c;
                      if (c[columnKey] !== undefined) {
                        (existingColumn as any)[columnKey] = c[columnKey];
                      }
                    });
                    return existingColumn;
                  }
                  return c;
                }),
                'Name',
              ),
              'Name',
            );

            /**
             * Add coverters to columns set by decorators
             * eg. @CreatedAt decorator etc.
             */
            for (const [key, val] of descriptor.Converters) {
              const column = d.Columns.find((c) => c.Name === key);
              if (column) {
                if (connection.Container.hasRegistered(val.Class)) {
                  column.Converter = connection.Container.resolve(val.Class);
                }
              }
            }

            // mark foreign key columns based on relation decorators ( if not foreign key is set in db explicit )
            // without this update / insert operations with populated data would fail
            descriptor.Relations.forEach((r) => {
              const c = d.Columns.find((c) => c.Name === r.ForeignKey);
              if (c) {
                c.IsForeignKey = true;
              }
            });

            /**
             * Add any other converted that is not set by decorators, but is set in container
             * for given column type eg. default boolean converter
             */
            d.Columns.forEach((c) => {
              if (!c.Converter) {
                if (converters && converters.has(c.NativeType.toLocaleLowerCase())) {
                  c.Converter = connection.Container.resolve<IValueConverter>(converters.get(c.NativeType.toLocaleLowerCase()));
                }
              }
            });

            // Build the model's JSON schema from its columns.
            d.Schema = buildModelJsonSchema(d);
          });
        }
      }
    }
  }

  public async resolve(): Promise<void> {

    await super.resolve();

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

    this.Migration = new MigrationRunner(this);

    // Must precede the migration pass below: `Migration.up()` reaches `ensureStorage()`, which
    // probes the tracking table with `driver.tableInfo()` - and a driver's `tableInfo()` may read
    // the '__orm_db_value_converters__' container map that this call is what puts there. Running
    // it afterwards left that map absent for the whole boot pass, which crashed every restart of
    // an already-migrated database ( the first boot creates the table and skips the probe, so it
    // never showed ). Nothing here touches the database or the models, so it is free to move up.
    this.registerDefaultConverters();

    // The boot migration pass, unless this Orm was resolved with MigrateOnStartup: false - see
    // IOrmOptions. Suppressed here rather than inside the runner on purpose: `plan()` reads the
    // OnStartup gate, so no `force` value can express "run nothing at all".
    //
    // force: false - the boot run honours each connection's Migration.OnStartup gate. Every
    // other caller ( CLI, an explicit orm.Migration.up() ) defaults to force: true, because
    // asking for a migration by hand is the explicit intent that gate exists to require.
    const migrateOnStartup = this.Options.MigrateOnStartup !== false;

    if (!migrateOnStartup) {
      this.Log.trace('Boot migration pass skipped - this Orm was resolved with MigrateOnStartup: false. Nothing is applied by resolving it; orm.Migration is assigned and usable.');
    }

    // [] when suppressed, so the data() phase below has nothing to seed - which is correct: it
    // seeds exactly what this pass applied, and this pass applied nothing.
    const executedMigrations = migrateOnStartup ? await this.Migration.up(undefined, { force: false }) : [];

    // reloadTableInfo / wireRelations / applyModelMixins and the data() phase all stay AFTER the
    // migration pass: up() runs against a schema no model is wired to yet, data() against one
    // that is.
    await this.reloadTableInfo();
    this.wireRelations();
    this.applyModelMixins();

    // Reached only if the pass above completed. A migration that throws takes this resolve down
    // with it, and the migrations that had already succeeded in that pass keep their recorded
    // schema while never reaching their `data()` - see the note on `runDataPhase`.
    await this.runDataPhase(executedMigrations);
  }

  /**
   * Runs the `data()` hook of every migration that was just applied - the seeding pass, which
   * happens after models and relations are wired because that is what it is allowed to use.
   *
   * Every hook runs even when an earlier one throws, and the failures are reported together.
   * Stopping at the first one leaves the migrations after it unseeded while their schema is
   * already applied and recorded, so a rerun will not retry them: their tracking rows say
   * "applied", and nothing would ever mention the seeds that never ran.
   *
   * KNOWN LOSS, and it is the same shape one level up: `executed` is what THIS run applied, and
   * this phase runs after the whole run. A run in which M1 applies and M2 throws never reaches
   * here at all - and M1's schema is already recorded, so the next boot does not find it pending,
   * it never enters `executed`, and `M1.data()` never runs on any boot. Nothing reports it: the
   * migration is applied and `status()` is clean.
   *
   * Not fixed here, because the tracking table has no notion of "applied but unseeded" and
   * inventing one would make the seed phase a second, weaker migration state machine - `data()`
   * has no `down()`, no checksum and no failure row, so a "seeded" column would be a claim
   * nothing could verify or undo. It is documented instead ( packages/orm/docs,
   * 10-schema-and-migrations.md ), where the guidance is the one thing that actually holds:
   * write `data()` so that running it again is harmless.
   */
  protected async runDataPhase(executed: OrmMigration[]): Promise<void> {
    // `error` is deliberately `unknown` and kept verbatim - a rejection value is not promoted to
    // an Error, so `inner` still carries whatever the hook actually threw. `reason` is the
    // human-readable rendering of it, computed once and used by both the log line and the aggregate.
    const errors: Array<{ name: string; reason: string; error: unknown }> = [];

    for (const m of executed) {
      this.Log.trace(`Migrating data function for migration ${m.constructor.name} ...`);

      try {
        await m.data();
      } catch (err) {
        // a hook is free to reject with something that is not an Error - `throw 'boom'`,
        // `Promise.reject(someCode)` - and reading `.message` off that yields undefined, so the
        // message reporting the failure would name no reason for it at all
        const reason = err instanceof Error ? err.message : String(err);

        this.Log.error(`Migration ${m.constructor.name}:data() failed: ${reason}`);
        errors.push({ name: m.constructor.name, reason, error: err });
      }
    }

    if (errors.length > 0) {
      // the first failure is carried as `inner` - the aggregate message names them all, but a
      // caller unwinding the chain gets the original rejection rather than this summary
      throw new OrmException(`Migration data() phase failed for: ${errors.map((e) => `${e.name} (${e.reason})`).join(', ')}`, undefined, undefined, undefined, errors[0].error);
    }
  }

  protected registerDefaultConverters() {
    this.Container.register(DatetimeValueConverter).asMapValue('__orm_db_value_converters__', Date.name);
    this.Container.register(DatetimeValueConverter).asMapValue('__orm_db_value_converters__', DateTime.name);
    this.Container.register(BooleanValueConverter).asMapValue('__orm_db_value_converters__', Boolean.name);
    this.Container.register(BooleanValueConverter).asMapValue('__orm_db_value_converters__', 'Bool');
    this.Container.register(BooleanValueConverter).asMapValue('__orm_db_value_converters__', Boolean.name.toLowerCase());
    this.Container.register(BooleanValueConverter).asMapValue('__orm_db_value_converters__', 'bool');
    this.Container.register(TimeValueConverter).asMapValue('__orm_db_value_converters__', 'Time');
    this.Container.register(TimeValueConverter).asMapValue('__orm_db_value_converters__', 'time');
    this.Container.register(TimeValueConverter).asMapValue('__orm_db_value_converters__', TimeSpan.name.toLowerCase());
    this.Container.register(TimeValueConverter).asMapValue('__orm_db_value_converters__', TimeSpan.name);
  }

  protected wireRelations() {
    this.Models.forEach((x) => {
      const desc = extractModelDescriptor(x.type);
      if (!desc) return;

      desc.Relations.forEach((rel) => {
        // Skip relations without TargetModelType (e.g., Query relations)
        if (!rel.TargetModelType) {
          return;
        }

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
    // validated here as well as in the runner, and deliberately: this is the earliest point the
    // class is seen, so a migration nobody can order is refused before the Orm reports itself
    // resolved rather than at the first migration run, possibly in another process
    const match = migration.name.match(MIGRATION_FILE_REGEXP);
    const created = match && match.length === 3 ? DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss') : null;

    if (created === null || !created.isValid) {
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
      const connectionInfo = JSON.stringify(_.pick(c, CFG_PROPS));
      this.Log.trace(`Trying to create connection name: ${c.Name}, driver: ${c.Driver}`);

      if (!this.Container.hasRegistered(c.Driver)) {
        throw new OrmException(`ORM connection driver ${c.Driver} not registerd`);
      }

      let driver: OrmDriver | null = null;
      try {
        driver = await this.Container.resolve<OrmDriver>(c.Driver, [c]);
      } catch (err) {
        this.Log.error(`Failed to resolve ORM driver ${c.Driver} for connection ${c.Name} with parameters ${connectionInfo}`);
        throw new OrmException(`Failed to resolve ORM driver ${c.Driver} for connection ${c.Name}`, c, undefined, undefined, err);
      }

      try {
        await driver.connect();
      } catch (err) {
        this.Log.error(`Failed to connect to database for connection ${c.Name} (driver: ${c.Driver}) with parameters ${connectionInfo}, reason: ${err instanceof Error ? err.message : String(err)}`);

        // Try to clean up driver resources on failed connection
        try {
          await driver.disconnect();
        } catch {
          // ignore cleanup errors
        }

        throw new OrmException(`Failed to connect to database for connection ${c.Name} (driver: ${c.Driver}). Check if the database server is running and accessible.`, c, undefined, undefined, err);
      }

      this.Connections.set(c.Name, driver);

      // a connection that was healthy at boot says nothing about one whose server has since
      // restarted, so the probe keeps running for the lifetime of the connection
      driver.startHealthCheck();
      this.Log.success(`Created ORM connection ${c.Name} with parameters ${connectionInfo}`);
    }

    const defaultConnection = this.Configuration.get<string>('db.DefaultConnection');
    if (defaultConnection) {
      if (!this.Connections.has(defaultConnection)) {
        throw new InvalidOperation(`default connection ${defaultConnection} not exists`);
      }

      this.Connections.set('default', this.Connections.get(defaultConnection)!);
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

      this.Connections.set(a, this.Connections.get(conn)!);
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

  public async dispose(): Promise<void> {
    for (const [, value] of this.Connections) {
      value.stopHealthCheck();
      await value.disconnect();
    }
  }
}
