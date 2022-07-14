import { SqliteTableExistsCompiler, SqliteColumnCompiler, SqliteTableQueryCompiler, SqliteOrderByCompiler, SqliteOnDuplicateQueryCompiler, SqliteInsertQueryCompiler } from './compilers';
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable prettier/prettier */

import { LogLevel } from '@spinajs/log-common';
export * from './compilers';

import { IColumnDescriptor, QueryContext, ColumnQueryCompiler, TableQueryCompiler, OrmDriver, QueryBuilder, TransactionCallback, OrderByQueryCompiler, JoinStatement, OnDuplicateQueryCompiler, InsertQueryCompiler, TableExistsCompiler, DefaultValueBuilder } from '@spinajs/orm';
import { Database, RunResult } from 'sqlite3';
import { SqlDriver } from '@spinajs/orm-sql';
import { Injectable } from '@spinajs/di';
import { SqlLiteJoinStatement } from './statements';
import { ResourceDuplicated } from '@spinajs/exceptions';
import { IIndexInfo, IIndexInfoList, ITableInfo } from './types';
import { format } from '@spinajs/configuration';
import { SqlLiteDefaultValueBuilder } from './builders';

@Injectable('orm-driver-sqlite')
export class SqliteOrmDriver extends SqlDriver {
  protected executionId = 0;

  protected Db: Database;

  public execute(stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    const queryParams = params ?? [];

    if (!this.Db) {
      throw new Error('cannot execute sqlite statement, no db connection avaible');
    }

    const tName = `query-${this.executionId++}`;
    this.Log.timeStart(`query-${tName}`);

    return new Promise((resolve, reject) => {
      switch (queryContext) {
        case QueryContext.Update:
        case QueryContext.Delete:
          this.Db.run(stmt, ...queryParams, function (this: RunResult, err: unknown) {
            if (err) {
              reject(err);
              return;
            }

            resolve({
              RowsAffected: this.changes,
            });
          });
          break;
        case QueryContext.Schema:
        case QueryContext.Transaction:
          this.Db.run(stmt, ...queryParams, (err: unknown, data: unknown) => {
            if (err) {
              reject(err);
              return;
            }

            resolve(data);
          });
          break;
        case QueryContext.Select:
          this.Db.all(stmt, ...queryParams, (err: unknown, rows: unknown) => {
            if (err) {
              reject(err);
              return;
            }

            resolve(rows);
          });
          break;
        case QueryContext.Insert:
          this.Db.run(stmt, ...queryParams, function (this: RunResult, err: any) {
            if (err) {
              if (err.code === 'SQLITE_CONSTRAINT') {
                reject(new ResourceDuplicated(err));
              } else {
                reject(err);
              }
              return;
            }

            resolve({
              RowsAffected: this.changes,
              LastInsertId: this.lastID,
            });
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

  public async ping(): Promise<boolean> {
    return this.Db !== null && this.Db !== undefined;
  }

  public async connect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      this.Db = new Database(format({}, this.Options.Filename), (err: unknown) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this);
      });
    });
  }

  public async disconnect(): Promise<OrmDriver> {
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
  }

  public async transaction(qrOrCallback: QueryBuilder[] | TransactionCallback) {
    if (!qrOrCallback) {
      return;
    }

    await this.execute('BEGIN TRANSACTION', null, QueryContext.Transaction);

    try {
      if (Array.isArray(qrOrCallback)) {
        for (const q of qrOrCallback) {
          await q;
        }
      } else {
        await qrOrCallback(this);
      }

      await this.execute('COMMIT', null, QueryContext.Transaction);
    } catch (ex) {
      await this.execute('ROLLBACK', null, QueryContext.Transaction);
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
    const tblInfo = (await this.execute(`PRAGMA table_info(${name});`, null, QueryContext.Select)) as ITableInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null;
    }

    // get all indices for table
    const indexList = (await this.execute(`PRAGMA index_list("${name}")`, null, QueryContext.Select)) as IIndexInfoList[];
    let uIndices: string[] = [];

    // get all unique & fetch for whitch column
    for (const idx of indexList.filter((i) => i.unique === 1)) {
      const iInfo = (await this.execute(`PRAGMA index_info("${idx.name}")`, null, QueryContext.Select)) as IIndexInfo[];
      uIndices = iInfo.map((x) => x.name);
    }

    return tblInfo.map((r: ITableInfo) => {
      return {
        Type: r.type,
        MaxLength: -1,
        Comment: '',
        DefaultValue: r.dflt_value,
        NativeType: r.type,
        Unsigned: false,
        Nullable: r.notnull === 0,
        PrimaryKey: r.pk === 1,
        Uuid: false,
        Ignore: false,

        // simply assumpt that integer pkeys are autoincement / auto fill  by default
        AutoIncrement: r.pk === 1 && r.type === 'INTEGER',
        Name: r.name,
        Converter: null,
        Schema: _schema ? _schema : this.Options.Database,
        Unique: uIndices.find((i) => i.includes(r.name)) !== undefined,
      };
    });
  }
}
