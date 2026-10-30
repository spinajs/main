import { BooleanValueConverter, DatetimeValueConverter, IValueConverter, TimeValueConverter } from './interfaces.js';
import { Configuration, normalizeEnvironment } from '@spinajs/configuration-common';
import { AsyncService, ClassInfo, Autoinject, Container, Class, DI, IContainer } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import _ from 'lodash';
import { IColumnDescriptor, IDriverOptions, IModelDescriptor, OrmMigration } from './interfaces.js';
import { ModelBase, MODEL_STATIC_MIXINS, updateModelDescriptor } from './model.js';
import type { OrmDriver } from './driver.js';
import { InvalidOperation } from '@spinajs/exceptions';
import { OrmException } from './exceptions.js';
import { DateTime } from 'luxon';
import { extractModelDescriptor, extractOwnMigrationDescriptor } from './descriptor.js';
import { buildModelJsonSchema } from './schema.js';
import { TimeSpan } from '@spinajs/util';
import { MIGRATION_FILE_REGEXP } from './migration-runner.js';
import { MIGRATION_DI_SOURCE, mergeMigrationEnv, resolveMigrationEnv } from './migration-environment.js';
import { MigrationSource } from './migration-sources.js';
import { inMigrationTool } from './schema-touches.js';

/**
 * Used to exclude sensitive data to others. eg. removed password field from cfg
 */
const CFG_PROPS = ['Database', 'User', 'Host', 'Port', 'Filename', 'Driver', 'Name'];

export interface IReloadTableInfoOptions {
  /** Read only these models; the others keep what the last read found. Default: every registered model. */
  models?: Array<Class<ModelBase>>;

  /**
   * Throw one OrmException listing every registered model whose table is missing, the models this call did not
   * read but recorded missing by an earlier read asked about again. Default false: warn per model read.
   */
  strict?: boolean;
}

/** A registered model whose table `tableInfo()` did not find. */
export interface IMissingModelTable {
  model: string;
  table: string;
  /** The name the model's `@Connection` uses: a connection, an alias or `default`. */
  connection: string;
  /** The configured `Name` of the driver that name resolved to. */
  target: string;
}

/** Each model's decorator columns, copied before the first table read merged anything into them. */
const DECLARED_COLUMNS = new WeakMap<Class<ModelBase>, IColumnDescriptor[]>();

function declaredColumns(model: Class<ModelBase>, descriptor: IModelDescriptor): IColumnDescriptor[] {
  let declared = DECLARED_COLUMNS.get(model);
  if (!declared) {
    declared = descriptor.Columns.map((c) => ({ ...c }));
    DECLARED_COLUMNS.set(model, declared);
  }

  return declared.map((c) => ({ ...c }));
}

function missingTablesMessage(missing: IMissingModelTable[]): string {
  const list = missing.map((m) => `model ${m.model}: table ${m.table} on connection ${m.connection}${m.target === m.connection ? '' : ` (${m.target})`}`);
  return `Missing tables (db.StrictTableCheck): ${list.join('; ')}. Create them (run their migrations) or set db.StrictTableCheck to false`;
}

export class Orm extends AsyncService {
  public Models: Array<ClassInfo<ModelBase>> = [];

  public Migrations: Array<ClassInfo<OrmMigration>> = [];

  public Connections: Map<string, OrmDriver> = new Map<string, OrmDriver>();

  /** What the last read of each model's table found missing, for a strict check over models a pass did not read. */
  protected MissingTables = new Map<Class<ModelBase>, IMissingModelTable>();

  @Autoinject()
  public Container: Container;

  @Logger('ORM')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  /** `db.StrictTableCheck`: only an explicit `false` turns it off, so a configuration replaced after validation keeps it on. */
  public get StrictTableCheck(): boolean {
    return this.Configuration.get<boolean>('db.StrictTableCheck', true) !== false;
  }

  /**
   * Reads the columns of the registered models' tables into their descriptors; call it after creating tables on a
   * resolved Orm. A model whose table is missing keeps only its decorator columns and is logged, or, with `strict`,
   * fails the call. With `db.StrictTableCheck` on, `Orm.resolve()` fails on a missing table of a connection without
   * `Migration.OnStartup`; `OrmMigrator` re-reads the models its migrations touched and checks every model after its
   * pass.
   */
  public async reloadTableInfo(options: IReloadTableInfoOptions = {}): Promise<void> {
    const missing = await this.readTableInfo(options.models);

    if (options.strict) {
      // what an earlier read found missing may exist by now ( created through a path no touch recorded, or by
      // another process ), so the driver is asked again rather than the record trusted
      const unread = options.models ? this.Models.filter((m) => this.MissingTables.has(m.type) && !options.models!.includes(m.type)).map((m) => m.type as Class<ModelBase>) : [];
      if (unread.length > 0) {
        await this.readTableInfo(unread);
      }

      const all = this.Models.filter((m) => this.MissingTables.has(m.type)).map((m) => this.MissingTables.get(m.type)!);

      if (all.length > 0) {
        throw new OrmException(missingTablesMessage(all));
      }

      return;
    }

    this.warnMissingTables(missing);
  }

  /** Reads `models` ( default: all ); resolves with the missing tables of the connections no `OrmMigrator` pass awaits. */
  protected async readTableInfo(models?: Array<Class<ModelBase>>): Promise<IMissingModelTable[]> {
    const read = models ? this.Models.filter((m) => models.includes(m.type)) : this.Models;
    const missing: IMissingModelTable[] = [];

    for (const m of read) {
      this.MissingTables.delete(m.type);
      const descriptor = extractModelDescriptor(m.type);
      if (descriptor) {
        const connection = this.Connections.get(descriptor.Connection!);

        if (!connection) {
          this.Log.warn({ connection: descriptor.Connection, model: descriptor.Name }, 'Cannot find connection ${connection} in connection list (model ${model})');
          continue;
        }

        const converters = connection.Container.get<Map<string, any>>('__orm_db_value_converters__');

        updateModelDescriptor(m.type, (d) => {
          d.Driver = connection;
        });

        const columns = await connection.tableInfo(descriptor.TableName, connection.Options.Database);
        if (columns) {
          updateModelDescriptor(m.type, (d) => {
            // Rebuilt from the declarations on every read: merging into the previous read would keep the columns a
            // migration dropped or renamed, and the converters their old types mapped to.
            const declared = declaredColumns(m.type, d);
            const read = _.uniqBy(columns, 'Name').map((c) => {
              const own = declared.find((x) => x.Name === c.Name);
              if (!own) {
                return { ...c };
              }

              // Merge only defined properties from table info
              Object.keys(c).forEach((key) => {
                const columnKey = key as keyof typeof c;
                if (c[columnKey] !== undefined) {
                  (own as any)[columnKey] = c[columnKey];
                }
              });
              return own;
            });

            d.Columns = _.unionBy(declared, read, 'Name');

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

            // Build the model's JSON schemas from its columns. Two of them: what a client may
            // SEND (`Schema`) and what a SELECT hands BACK (`ResponseSchema`) are not the same
            // contract - see buildModelJsonSchema.
            d.Schema = buildModelJsonSchema(d);
            d.ResponseSchema = buildModelJsonSchema(d, 'response');
          });
        } else {
          updateModelDescriptor(m.type, (d) => {
            d.Columns = declaredColumns(m.type, d);
          });

          const entry = { model: m.name, table: descriptor.TableName, connection: descriptor.Connection!, target: connection.Options.Name };
          this.MissingTables.set(m.type, entry);

          // the migrator creates it and its strict check reports it if it does not
          if (connection.AwaitsStartupMigration) {
            this.Log.trace(entry, 'Table ${table} of model ${model} does not exist on connection ${connection} yet; OrmMigrator runs its migrations');
          } else {
            missing.push(entry);
          }
        }
      }
    }

    return missing;
  }

  protected warnMissingTables(missing: IMissingModelTable[]): void {
    for (const m of missing) {
      this.Log.warn({ model: m.model, table: m.table, connection: m.connection }, 'Table ${table} of model ${model} does not exist on connection ${connection}; the model has no column info');
    }
  }

  public async resolve(): Promise<void> {
    await super.resolve();

    await this.createConnections();

    // Every registered MigrationSource, merged, env-filtered and deduped. Deliberately BEFORE the
    // model registration below: a discovered file may declare models as well, and importing it
    // has to happen before `__models__` is read.
    for (const m of await this.discoverMigrations()) {
      this.registerMigration(m.type, m.file);
    }

    const models = DI.getRegisteredTypes<ModelBase>('__models__');
    if (models) {
      models.forEach((m) => {
        this.registerModel(m);
      });
    }

    // A driver's tableInfo() may read the '__orm_db_value_converters__' map this registers.
    this.registerDefaultConverters();

    // A connection without Migration.OnStartup was migrated before this process started ( migrate-up ), so it is
    // checked here; OrmMigrator checks the OnStartup ones after its pass. A migration tool resolves the Orm before
    // the tables it is about to create exist.
    const missing = await this.readTableInfo();

    if (missing.length > 0 && this.StrictTableCheck && !inMigrationTool()) {
      // a rejected resolve caches no Orm, so nobody else could close the connections it opened
      await this.dispose().catch(() => undefined);
      throw new OrmException(missingTablesMessage(missing));
    }

    this.warnMissingTables(missing);

    this.wireRelations();
    this.applyModelMixins();
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
   * Everything every `MigrationSource` found, reduced to the migrations this environment runs.
   *
   * Three passes, in this order and for a reason each:
   *
   * - env resolution happens per ENTRY, before anything is merged, because it is the entry's FILE
   *   that carries the suffix;
   * - dedupe merges entries sharing a class name - the normal case, since a file discovered on
   *   disk is also registered through DI by the import that discovered it, and `src` and `lib`
   *   hold the same class twice;
   * - filtering happens here rather than in `MigrationRunner.plan()` so a migration belonging to
   *   another environment never enters `Orm.Migrations` at all, and is therefore absent from
   *   `up`, `down` AND `status` alike.
   */
  protected async discoverMigrations(): Promise<Array<{ type: Class<OrmMigration>; file: string }>> {
    const sources = await this.Container.resolve(Array.ofType(MigrationSource));
    const merged = new Map<string, { type: Class<OrmMigration>; file: string; env?: string }>();

    for (const source of sources) {
      for (const found of await source.getMigrations()) {
        // OWN only - see the note on `extractOwnMigrationDescriptor`. A subclass that carries no
        // `@Migration()` of its own must be read as "no Env declared", not as whatever its nearest
        // decorated ancestor declared: a subclass does not inherit WHERE its parent runs.
        const descriptor = extractOwnMigrationDescriptor(found.type);
        const env = resolveMigrationEnv(found.name, found.file, descriptor?.Env);
        const previous = merged.get(found.name);

        if (!previous) {
          merged.set(found.name, { type: found.type, file: found.file, env });
          continue;
        }

        if (previous.type !== found.type) {
          // two DIFFERENT classes under one name - the runner records migrations by name, so only
          // one of them can ever be tracked. Nothing here can tell which is meant. The env merge
          // below is skipped on purpose: merging environments across two unrelated classes would
          // surface as "the same migration cannot belong to two environments", contradicting the
          // warning just logged - so the first entry is kept untouched instead.
          this.Log.warn({ migration: found.name, firstFile: previous.file, secondFile: found.file }, 'Two different migration classes are both named ${migration} ( ${firstFile} and ${secondFile} ) - keeping the first. Rename one of them.');
          continue;
        }

        // Prefer a real path over the '<di>' sentinel: each ClassInfo.file is meant to carry the
        // migration's actual origin, and a DI registration that resolved before the file-scan
        // source ran must not make the survivor forget the real path the same class was also
        // discovered at.
        const file = previous.file === MIGRATION_DI_SOURCE && found.file !== MIGRATION_DI_SOURCE ? found.file : previous.file;

        merged.set(found.name, {
          type: previous.type,
          file,
          env: mergeMigrationEnv(found.name, { env: previous.env, file: previous.file }, { env, file: found.file }),
        });
      }
    }

    const environment = normalizeEnvironment(this.Configuration.get<string>('process.env.APP_ENV', undefined));

    return [...merged.values()].filter((m) => {
      if (m.env === undefined || m.env === environment) {
        return true;
      }

      this.Log.trace({ migration: m.type.name, migrationEnv: m.env, environment }, 'Migration ${migration} belongs to environment ${migrationEnv} and this process runs as ${environment} - it is not registered');
      return false;
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
  protected registerMigration<T extends OrmMigration>(migration: Class<T>, file?: string) {
    // validated here as well as in the runner, and deliberately: this is the earliest point the
    // class is seen, so a migration nobody can order is refused before the Orm reports itself
    // resolved rather than at the first migration run, possibly in another process
    const match = migration.name.match(MIGRATION_FILE_REGEXP);
    const created = match && match.length === 3 ? DateTime.fromFormat(match[2], 'yyyy_MM_dd_HH_mm_ss') : null;

    if (created === null || !created.isValid) {
      throw new OrmException(`Migration file ${migration.name} have invalid name format ( invalid migration name,  expected: some_name_yyyy_MM_dd_HH_mm_ss got ${migration.name})`);
    }

    this.Migrations.push({
      file: file ?? `${migration.name}.registered`,
      name: `${migration.name}`,
      type: migration,
    });
  }

  private async createConnections() {
    const cConnections = this.Configuration.get<IDriverOptions[]>('db.Connections', []);

    for (const c of cConnections) {
      const parameters = _.pick(c, CFG_PROPS);
      this.Log.trace({ connection: c.Name, driver: c.Driver }, 'Trying to create connection name: ${connection}, driver: ${driver}');

      if (!this.Container.hasRegistered(c.Driver)) {
        throw new OrmException(`ORM connection driver ${c.Driver} not registerd`);
      }

      let driver: OrmDriver | null = null;
      try {
        driver = await this.Container.resolve<OrmDriver>(c.Driver, [c]);
      } catch (err) {
        this.Log.error({ driver: c.Driver, connection: c.Name, parameters }, 'Failed to resolve ORM driver ${driver} for connection ${connection} with parameters ${parameters}');
        throw new OrmException(`Failed to resolve ORM driver ${c.Driver} for connection ${c.Name}`, c, undefined, undefined, err);
      }

      try {
        await driver.connect();
      } catch (err) {
        this.Log.error({ error: err, connection: c.Name, driver: c.Driver, parameters }, 'Failed to connect to database for connection ${connection} (driver: ${driver}) with parameters ${parameters}');

        // Try to clean up driver resources on failed connection
        try {
          await driver.disconnect();
        } catch {
          // ignore cleanup errors
        }

        throw new OrmException(`Failed to connect to database for connection ${c.Name} (driver: ${c.Driver}). Check if the database server is running and accessible.`, c, undefined, undefined, err);
      }

      this.Connections.set(c.Name, driver);
      driver.AwaitsStartupMigration = c.Migration?.OnStartup === true;

      // a connection that was healthy at boot says nothing about one whose server has since
      // restarted, so the probe keeps running for the lifetime of the connection
      driver.startHealthCheck();
      this.Log.success({ connection: c.Name, parameters }, 'Created ORM connection ${connection} with parameters ${parameters}');
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
    const aliases = this.Configuration.get<Record<string, string>>('db.Aliases', {});
    for (const a in aliases) {
      const conn = aliases[a];
      if (!this.Connections.has(conn)) {
        // Packages default aliases for their own models; one that cannot resolve concerns only those models.
        this.Log.warn({ alias: a, connection: conn }, 'Connection alias ${alias} points at ${connection}, which does not exist; models and migrations on ${alias} are skipped');
        continue;
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
