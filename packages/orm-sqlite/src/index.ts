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

import { IColumnDescriptor, QueryContext, ColumnQueryCompiler, TableQueryCompiler, OrmDriver, QueryBuilder, TransactionCallback, OrderByQueryCompiler, JoinStatement, OnDuplicateQueryCompiler, InsertQueryCompiler, TableExistsCompiler, DefaultValueBuilder, TruncateTableQueryCompiler, ModelToSqlConverter, OrmException, ValueConverter, ServerResponseMapper, ISupportedFeature } from '@spinajs/orm';
import sqlite3 from 'sqlite3';
import { SqlDriver } from '@spinajs/orm-sql';
import { Injectable, NewInstance } from '@spinajs/di';
import { SqlLiteJoinStatement } from './statements.js';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { IForeignKeyList, IIndexInfo, IIndexInfoList, ITableInfo } from './types.js';
import { format } from '@spinajs/configuration';
import { SqlLiteDefaultValueBuilder } from './builders.js';
import { SqliteModelToSqlConverter } from './converters.js';

export class SqliteServerResponseMapper extends ServerResponseMapper {
  public read(data: any, pkName: string) {
    return {
      LastInsertId: Array.isArray(data) ? data[data.length - 1][pkName] : data.LastInsertId,
    };
  }
}

@Injectable('orm-driver-sqlite')
@NewInstance()
export class SqliteOrmDriver extends SqlDriver {
  protected executionId = 0;

  protected Db: sqlite3.Database;

  public executeOnDb(stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    const queryParams = params ?? [];
    const self = this;

    if (!this.Db) {
      throw new Error('cannot execute sqlite statement, no db connection avaible');
    }

    const tName = `query-${this.executionId++}`;
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
            error: null,
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
    return { events: false };
  }

  public async ping(): Promise<boolean> {
    return this.Db !== null && this.Db !== undefined;
  }

  public async connect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      this.Db = new sqlite3.Database(format({}, this.Options.Filename), (err: unknown) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this);
      });
    });
  }

  public async disconnect(): Promise<OrmDriver> {
    if (!this.Db) {
      return;
    }

    return new Promise((resolve, reject) => {
      this.Db.close((err: any) => {
        if (err) {
          reject(err);
          return;
        }

        this.Db = null;
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

  public async transaction(qrOrCallback: QueryBuilder[] | TransactionCallback) {
    if (!qrOrCallback) {
      return;
    }

    await this.executeOnDb('BEGIN TRANSACTION', null, QueryContext.Transaction);

    try {
      if (Array.isArray(qrOrCallback)) {
        for (const q of qrOrCallback) {
          await q;
        }
      } else {
        await qrOrCallback(this);
      }

      await this.executeOnDb('COMMIT', null, QueryContext.Transaction);
    } catch (ex) {
      await this.executeOnDb('ROLLBACK', null, QueryContext.Transaction);
      throw ex;
    }
  }

  /**
   *
   * Retrieves information about specific DB table if exists. If table not exists returns null
   *
   * @param name - table name to retrieve info
   * @param _schema - optional schema name
   */
  public async tableInfo(name: string, _schema?: string): Promise<IColumnDescriptor[]> {
    const converters = this.Container.get<Map<string, any>>('__orm_db_value_converters__');

    const tblInfo = (await this.executeOnDb(`PRAGMA table_info(${name});`, null, QueryContext.Select)) as ITableInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null;
    }

    // get all indices for table
    const indexList = (await this.executeOnDb(`PRAGMA index_list("${name}")`, null, QueryContext.Select)) as IIndexInfoList[];
    let uIndices: string[] = [];

    // get all unique & fetch for whitch column
    for (const idx of indexList.filter((i) => i.unique === 1)) {
      const iInfo = (await this.executeOnDb(`PRAGMA index_info("${idx.name}")`, null, QueryContext.Select)) as IIndexInfo[];
      uIndices = iInfo.map((x) => x.name);
    }

    // get all foreign keys
    const foreignKeys = (await this.executeOnDb(`PRAGMA foreign_key_list("${name}")`, null, QueryContext.Select)) as IForeignKeyList[];

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
        PrimaryKey: r.pk === 1,
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
          : null,
        // simply assumpt that integer pkeys are autoincement / auto fill  by default
        AutoIncrement: r.pk === 1 && r.type === 'INTEGER',
        Name: r.name,
        Converter: null as any,
        Schema: _schema ? _schema : this.Options.Database,
        Unique: uIndices.find((i) => i.includes(r.name)) !== undefined,
      };
    });
  }
}
