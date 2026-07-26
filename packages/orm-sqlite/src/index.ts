import { SqliteTableExistsCompiler, SqliteColumnCompiler, SqliteTableQueryCompiler, SqliteOrderByCompiler, SqliteOnDuplicateQueryCompiler, SqliteInsertQueryCompiler, SqliteTruncateTableQueryCompiler } from './compilers.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable prettier/prettier */

import { LogLevel } from '@spinajs/log-common';
export * from './compilers.js';

import { IColumnDescriptor, QueryContext, ColumnQueryCompiler, TableQueryCompiler, OrmDriver, OrderByQueryCompiler, JoinStatement, OnDuplicateQueryCompiler, InsertQueryCompiler, TableExistsCompiler, DefaultValueBuilder, TruncateTableQueryCompiler, ModelToSqlConverter, OrmException, ValueConverter, ServerResponseMapper, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions, ConnectionState } from '@spinajs/orm';
import sqlite3 from 'sqlite3';
import { escapeIdentifier, SqlDriver } from '@spinajs/orm-sql';
import { Injectable, NewInstance } from '@spinajs/di';
import { SqlLiteJoinStatement } from './statements.js';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { IForeignKeyList, IIndexInfo, IIndexInfoList, ITableInfo } from './types.js';
import { format } from '@spinajs/configuration';
import { SqlLiteDefaultValueBuilder } from './builders.js';
import { SqliteModelToSqlConverter } from './converters.js';

export class SqliteServerResponseMapper extends ServerResponseMapper {
  public read(data: any, pkNames?: string[]) {
    // Upsert and returning-inserts resolve with the RETURNING rows; plain runs resolve with
    // { RowsAffected, LastInsertId }.
    if (Array.isArray(data)) {
      const last = data.length !== 0 ? data[data.length - 1] : undefined;
      const key = pkNames && pkNames.length === 1 && last ? last[pkNames[0]] : 0;

      return {
        RowsAffected: data.length,
        // A uuid / assigned key is not a number and has no identity semantics.
        LastInsertId: typeof key === 'number' ? key : 0,
        Returning: data,
      };
    }

    // A RETURNING insert already arrives normalized by executeOnDb, carrying its rows; a plain
    // run carries none. Passing the rows through is what lets the caller read generated keys.
    return {
      RowsAffected: data?.RowsAffected ?? 0,
      LastInsertId: data?.LastInsertId ?? 0,
      Returning: Array.isArray(data?.Returning) ? data.Returning : ([] as any[]),
    };
  }
}

@Injectable('orm-driver-sqlite')
@NewInstance()
export class SqliteOrmDriver extends SqlDriver {
  protected executionId = 0;

  protected Db: sqlite3.Database;

  /**
   * sqlite3 outside shared-cache mode serializes access to the database file, which is
   * SERIALIZABLE and nothing else. Any other requested level is rejected by the base class
   * rather than silently ignored.
   */
  public readonly SupportedIsolationLevels: IsolationLevel[] = ['SERIALIZABLE'];

  private getNextExecutionId(): number {
    this.executionId = (this.executionId + 1) % Number.MAX_SAFE_INTEGER;
    return this.executionId;
  }

  public executeOnDb(stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    const queryParams = params ?? [];
    const self = this;

    if (!this.Db) {
      throw new Error('cannot execute sqlite statement, no db connection avaible');
    }

    const tName = `query-${this.getNextExecutionId()}`;
    this.Log.timeStart(`query-${tName}`);

    return new Promise((resolve, reject) => {
      switch (queryContext) {
        case QueryContext.Update:
        case QueryContext.Delete:
          this.Db.run(stmt, ...queryParams, function (this: sqlite3.RunResult, err: unknown) {
            if (err) {
              reject(
                new OrmException(
                  `Failed to execute query`,
                  {
                    Host: self.Options.Host,
                    User: self.Options.User,
                    Name: self.Options.Name,
                  },
                  stmt,
                  params ? params.join(',') : 'none',
                  err,
                ),
              );
              return;
            }

            resolve({
              RowsAffected: this.changes,
            });
          });
          break;

        case QueryContext.Select:
        case QueryContext.Upsert:
        case QueryContext.InsertReturning:
          this.Db.all(stmt, ...queryParams, (err: unknown, rows: unknown) => {
            if (err) {
              reject(
                new OrmException(
                  `Failed to execute query`,
                  {
                    Host: self.Options.Host,
                    User: self.Options.User,
                    Name: self.Options.Name,
                  },
                  stmt,
                  params ? params.join(',') : 'none',
                  err,
                ),
              );
              return;
            }

            // A RETURNING insert resolves with rows, so it must be normalized into the same
            // IInsertResult shape the Db.run path produces.
            if (queryContext === QueryContext.InsertReturning) {
              const returned = (rows as any[]) ?? [];
              resolve({
                RowsAffected: returned.length,
                LastInsertId: 0,
                Returning: returned,
              });
              return;
            }

            resolve(rows);
          });
          break;

        case QueryContext.Insert:
          this.Db.run(stmt, ...queryParams, function (this: sqlite3.RunResult, err: any) {
            if (err) {
              if (err.code === 'SQLITE_CONSTRAINT') {
                reject(new ResourceDuplicated(err));
              } else {
                if (err) {
                  reject(
                    new OrmException(
                      `Failed to execute query`,
                      {
                        Host: self.Options.Host,
                        User: self.Options.User,
                        Name: self.Options.Name,
                      },
                      stmt,
                      params ? params.join(',') : 'none',
                      err,
                    ),
                  );
                  return;
                }
              }
              return;
            }

            resolve({
              RowsAffected: this.changes,
              LastInsertId: this.lastID,
              Returning: [],
            });
          });
          break;
        case QueryContext.Schema:
        case QueryContext.Transaction:
        default:
          this.Db.run(stmt, ...queryParams, (err: unknown, data: unknown) => {
            if (err) {
              reject(new OrmException(`Failed to execute query: ${stmt}, bindings: ${params ? params.join(',') : 'none'}`));
              return;
            }

            resolve(data);
          });
          break;
      }
    })
      .then((val) => {
        const tDiff = this.Log.timeEnd(`query-${tName}`);

        void this.Log.write({
          Level: LogLevel.Trace,
          Variables: {
            error: undefined,
            message: `Executed: ${stmt}, bindings: ${params ? params.join(',') : 'none'}`,
            logger: this.Log.Name,
            level: 'TRACE',
            duration: tDiff,
          },
        });

        return val;
      })
      .catch((err) => {
        const tDiff = this.Log.timeEnd(`query-${tName}`);

        void this.Log.write({
          Level: LogLevel.Error,
          Variables: {
            error: err,
            message: `Failed: ${stmt}, bindings: ${params ? params.join(',') : 'none'}`,
            logger: this.Log.Name,
            level: 'Error',
            duration: tDiff,
          },
        });

        throw err;
      });
  }

  public supportedFeatures(): ISupportedFeature {
    // insertIdIsFirstOfBatch is false: sqlite3's `lastID` is the LAST rowid the statement
    // produced, not the first. SQLite does not need it — it gets every key from RETURNING.
    return { events: false, insertReturning: true, insertIdIsFirstOfBatch: false };
  }

  public async ping(): Promise<boolean> {
    return this.Db !== null && this.Db !== undefined;
  }

  public async connect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      this.Db = new sqlite3.Database(format({}, this.Options.Filename!), (err: unknown) => {
        if (err) {
          // Clean up the database handle if connection fails
          if (this.Db) {
            this.Db.close(() => {
              this.Db = null as any;
              reject(err);
            });
          } else {
            reject(err);
          }
          return;
        }

        this.setState(ConnectionState.Connected);
        resolve(this);
      });
    });
  }

  public async disconnect(): Promise<OrmDriver> {
    this.stopHealthCheck();
    this.setState(ConnectionState.Disconnected);

    if (!this.Db) {
      return this;
    }

    return new Promise((resolve, reject) => {
      this.Db.close((err: any) => {
        if (err) {
          reject(err);
          return;
        }

        this.Db = null as any;
        resolve(this);
      });
    });
  }

  public resolve() {
    super.resolve();

    this.Container.register(SqliteColumnCompiler).as(ColumnQueryCompiler);
    this.Container.register(SqliteTableQueryCompiler).as(TableQueryCompiler);
    this.Container.register(SqliteOrderByCompiler).as(OrderByQueryCompiler);
    this.Container.register(SqlLiteJoinStatement).as(JoinStatement);
    this.Container.register(SqliteOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
    this.Container.register(SqliteInsertQueryCompiler).as(InsertQueryCompiler);
    this.Container.register(SqliteTableExistsCompiler).as(TableExistsCompiler);
    this.Container.register(SqlLiteDefaultValueBuilder).as(DefaultValueBuilder);
    this.Container.register(SqliteTruncateTableQueryCompiler).as(TruncateTableQueryCompiler);
    this.Container.register(SqliteModelToSqlConverter).as(ModelToSqlConverter);
    this.Container.register(SqliteServerResponseMapper).as(ServerResponseMapper);
  }

  protected async _begin(_options?: ITransactionOptions): Promise<ITransactionContext> {
    await this.executeOnDb('BEGIN TRANSACTION', [] as any, QueryContext.Transaction);

    // sqlite3 gives us a single shared handle, so there is no per-transaction connection
    // to carry — everything on this driver already runs on the same `this.Db`.
    return { depth: 0 };
  }

  protected async _commit(_ctx: ITransactionContext): Promise<void> {
    await this.executeOnDb('COMMIT', [] as any, QueryContext.Transaction);
  }

  protected async _rollback(_ctx: ITransactionContext): Promise<void> {
    await this.executeOnDb('ROLLBACK', [] as any, QueryContext.Transaction);
  }

  // savepoint names cannot be bound parameters, so they are inlined through the identifier
  // escaper rather than passed as `?`
  protected async _savepoint(_ctx: ITransactionContext, name: string): Promise<void> {
    await this.executeOnDb(`SAVEPOINT ${escapeIdentifier(name)}`, [] as any, QueryContext.Transaction);
  }

  protected async _releaseSavepoint(_ctx: ITransactionContext, name: string): Promise<void> {
    await this.executeOnDb(`RELEASE ${escapeIdentifier(name)}`, [] as any, QueryContext.Transaction);
  }

  protected async _rollbackToSavepoint(_ctx: ITransactionContext, name: string): Promise<void> {
    await this.executeOnDb(`ROLLBACK TO ${escapeIdentifier(name)}`, [] as any, QueryContext.Transaction);
  }

  protected async _dispose(_ctx: ITransactionContext): Promise<void> {
    // nothing to release — the sqlite3 handle is owned by the driver, not by the transaction
  }

  /**
   *
   * Retrieves information about specific DB table if exists. If table not exists returns null
   *
   * @param name - table name to retrieve info
   * @param _schema - optional schema name
   */
  public async tableInfo(name: string, _schema?: string): Promise<IColumnDescriptor[]> {
    const converters = this.Container.get<Map<string, any>>('__orm_db_value_converters__')!;

    const tblInfo = (await this.executeOnDb(`PRAGMA table_info(${name});`, [] as any, QueryContext.Select)) as ITableInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null as any;
    }

    // get all indices for table
    const indexList = (await this.executeOnDb(`PRAGMA index_list("${name}")`, [] as any, QueryContext.Select)) as IIndexInfoList[];
    let uIndices: string[] = [];

    // get all unique & fetch for whitch column
    for (const idx of indexList.filter((i) => i.unique === 1)) {
      const iInfo = (await this.executeOnDb(`PRAGMA index_info("${idx.name}")`, [] as any, QueryContext.Select)) as IIndexInfo[];
      uIndices = iInfo.map((x) => x.name);
    }

    // get all foreign keys
    const foreignKeys = (await this.executeOnDb(`PRAGMA foreign_key_list("${name}")`, [] as any, QueryContext.Select)) as IForeignKeyList[];

    // PRAGMA table_info reports `pk` as the 1-BASED POSITION within the primary key, not a
    // boolean. Every column with pk > 0 is part of the key.
    const pkColumnCount = tblInfo.filter((r) => r.pk > 0).length;

    return tblInfo.map((r: ITableInfo) => {
      const fk = foreignKeys.find((i) => i.from === r.name);
      const converter = converters.get(r.type.toLocaleLowerCase());
      return {
        Type: r.type,
        MaxLength: -1,
        Comment: '',
        DefaultValue: converter ? this.Container.resolve<ValueConverter>(converters.get(r.type.toLocaleLowerCase())).fromDB(r.dflt_value) : r.dflt_value,
        NativeType: r.type,
        Unsigned: false,
        Nullable: r.notnull === 0,
        PrimaryKey: r.pk > 0,
        Uuid: false,
        Ignore: false,
        IsForeignKey: fk !== undefined,
        Aggregate: false,
        Virtual: false,
        ForeignKeyDescription: fk
          ? {
              From: fk.from,
              Table: fk.table,
              To: fk.to,
            }
          : null as any,
        // sqlite only auto-fills a lone INTEGER PRIMARY KEY ( the rowid alias ); a composite
        // key never auto-increments, so the column count has to be checked too.
        AutoIncrement: pkColumnCount === 1 && r.pk === 1 && r.type === 'INTEGER',
        Name: r.name,
        Converter: null as any,
        Schema: _schema ? _schema : this.Options.Database,
        Unique: uIndices.find((i) => i.includes(r.name)) !== undefined,
      };
    });
  }
}
