/* eslint-disable prettier/prettier */
export * from './compilers';

import { IColumnDescriptor, QueryContext, ColumnQueryCompiler, TableQueryCompiler, OrmDriver, QueryBuilder, TransactionCallback, OrderByQueryCompiler, JoinStatement, OnDuplicateQueryCompiler, InsertQueryCompiler, DatetimeValueConverter } from '@spinajs/orm';
import { Database } from 'sqlite3';
import { SqlDriver } from '@spinajs/orm-sql';
import { Injectable, Container } from '@spinajs/di';
import { SqliteColumnCompiler, SqliteTableQueryCompiler, SqliteOrderByCompiler, SqliteOnDuplicateQueryCompiler, SqliteInsertQueryCompiler } from './compilers';
import { SqlLiteJoinStatement } from './statements';
import { SqliteDatetimeValueConverter } from './converters';
import { ResourceDuplicated } from '@spinajs/exceptions';

@Injectable('orm-driver-sqlite')
export class SqliteOrmDriver extends SqlDriver {
  protected Db: Database;

  public execute(stmt: string, params: any[], queryContext: QueryContext): Promise<any> {
    const queryParams = params ?? [];

    if (!this.Db) {
      throw new Error('cannot execute sqlite statement, no db connection avaible');
    }

    this.trac

    return new Promise((resolve, reject) => {
      switch (queryContext) {
        case QueryContext.Update:
        case QueryContext.Delete:
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
          this.Db.run(stmt, ...queryParams, function (this: Database, err: unknown) {
            if (err) {
              if (err.code === 'SQLITE_CONSTRAINT') {
                reject(new ResourceDuplicated(err));
              } else {
                reject(err);
              }
              return;
            }

            resolve(this.lastID);
          });
          break;
      }
    });
  }

  public async ping(): Promise<boolean> {
    return this.Db !== null && this.Db !== undefined;
  }

  public async connect(): Promise<OrmDriver> {
    return new Promise((resolve, reject) => {
      this.Db = new Database(this.Options.Filename, (err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(this);
      });
    });
  }

  public async disconnect(): Promise<OrmDriver> {
    return new Promise((res, rej) => {
      this.Db.close((err) => {
        if (err) {
          rej(err);
          return;
        }

        this.Db = null;
        res(this);
      });
    });
  }

  public async resolve(container: Container) {
    super.resolve(container);

    this.Container.register(SqliteColumnCompiler).as(ColumnQueryCompiler);
    this.Container.register(SqliteTableQueryCompiler).as(TableQueryCompiler);
    this.Container.register(SqliteOrderByCompiler).as(OrderByQueryCompiler);
    this.Container.register(SqlLiteJoinStatement).as(JoinStatement);
    this.Container.register(SqliteOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
    this.Container.register(SqliteInsertQueryCompiler).as(InsertQueryCompiler);
    this.Container.register(SqliteDatetimeValueConverter).as(DatetimeValueConverter);
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
   * @param name table name to retrieve info
   * @param _schema - optional schema name
   * @returns {[] | null}
   */
  public async tableInfo(name: string, _schema?: string): Promise<IColumnDescriptor[]> {
    const tblInfo = (await this.execute(`PRAGMA table_info(${name});`, null, QueryContext.Select)) as [];

    const indexInfo = (await this.execute(`select type, name, tbl_name, sql FROM sqlite_master WHERE type='index' AND tbl_name='${name}'`, null, QueryContext.Select)) as [];

    const re = /\((.*?)\)/;
    const indices = indexInfo.map((i: any) => {
      return {
        table: i.tbl_name,
        column_name: i.sql?.match(re)[0],
      };
    });

    if (!Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null;
    }

    return tblInfo.map((r: any) => {
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
        Unique: indices.find((i) => i.column_name && i.column_name.includes(r.name) && i.table === name) !== undefined,
      };
    });
  }
}
