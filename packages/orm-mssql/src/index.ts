/* eslint-disable security/detect-object-injection */
import { Injectable } from '@spinajs/di';
import { LogLevel } from '@spinajs/log-common';
import { QueryContext, OrmDriver, IColumnDescriptor, QueryBuilder, TransactionCallback } from '@spinajs/orm';
import { SqlDriver } from '@spinajs/orm-sql';
import { connect, ConnectionPool, Request } from 'mssql';
import { IIndexInfo, ITableInfo } from './types';

@Injectable('orm-driver-mssql')
export class MsSqlOrmDriver extends SqlDriver {
  protected _connectionPool: ConnectionPool = null;
  protected _executionId = 0;
  protected _transactionRequest: Request = null;

  public async execute(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const findIndexes = (str: string): number[] => {
      let idx = 0;
      let pos = 0;
      const indices: number[] = [];

      while ((idx = str.indexOf(stmt, pos)) !== -1) {
        pos = idx;
        indices.push(idx);
      }
      return indices;
    };

    const tName = `query-${this._executionId++}`;
    let finalQuery = stmt;

    this.Log.timeStart(`query-${tName}`);
    try {
      const req = this._transactionRequest ?? this._connectionPool.request();
      const indexes = findIndexes(stmt);

      for (let i = 0; i < indexes.length; i++) {
        finalQuery = finalQuery.substring(indexes[i], 1) + `p${i}` + finalQuery.substring(indexes[i] + 1);
        req.input(`p${i}`, params[i]);
      }

      const result = await req.query(finalQuery);

      const tDiff = this.Log.timeEnd(`query-${tName}`);
      void this.Log.write({
        Level: LogLevel.Trace,
        Variables: {
          error: null,
          message: `Executed: ${finalQuery}, bindings: ${params ? params.join(',') : 'none'}`,
          logger: this.Log.Name,
          level: 'TRACE',
          duration: tDiff,
        },
      });

      switch (context) {
        case QueryContext.Update:
        case QueryContext.Delete:
          return {
            RowsAffected: result.rowsAffected,
          };
        case QueryContext.Insert:
          return {
            RowsAffected: result.rowsAffected,
            LastInsertId: result.output['ID'],
          };
        default:
          return result.recordsets;
      }
    } catch (err) {
      const tDiff = this.Log.timeEnd(`query-${tName}`);

      void this.Log.write({
        Level: LogLevel.Error,
        Variables: {
          error: err,
          message: `Failed: ${finalQuery}, bindings: ${params ? params.join(',') : 'none'}`,
          logger: this.Log.Name,
          level: 'Error',
          duration: tDiff,
        },
      });

      throw err;
    }
  }

  public async ping(): Promise<boolean> {
    try {
      await this.execute('SELECT 1', [], QueryContext.Select);
      return true;
    } catch {
      return false;
    }
  }

  public async connect(): Promise<OrmDriver> {
    this._connectionPool = await connect({
      user: this.Options.User,
      password: this.Options.Password,
      database: this.Options.Database,
      server: this.Options.Host,
      pool: {
        max: this.Options.PoolLimit ?? 10,
        min: 0,
        idleTimeoutMillis: 3000,
      },
    });

    return this;
  }

  public async disconnect(): Promise<OrmDriver> {
    await this._connectionPool.close();
    return this;
  }

  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    const tblInfo = (await this.execute(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? ${schema ? ' AND TABLE_SCHEMA=?' : ''}`, schema ? [name, schema] : [name], QueryContext.Select)) as ITableInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null;
    }

    const indexList = (await this.execute(`select C.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS T JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE C ON C.CONSTRAINT_NAME=T.CONSTRAINT_NAME WHERE C.TABLE_NAME=? ${schema ? ' AND TABLE_SCHEMA=?' : ''}`, schema ? [name, schema] : [name], QueryContext.Select)) as IIndexInfo[];

    return tblInfo.map((r: ITableInfo) => {
      const isPrimary = indexList.find((c) => c.CONSTRAINT_TYPE === 'PRIMARY KEY' && c.COLUMN_NAME === r.COLUMN_NAME) !== undefined;
      const sUnique = indexList.find((c) => c.CONSTRAINT_TYPE === 'UNIQUE' && c.COLUMN_NAME === r.COLUMN_NAME) !== undefined;
      return {
        Type: r.DATA_TYPE,
        MaxLength: -1,
        Comment: '',
        DefaultValue: r.COLUMN_DEFAULT,
        NativeType: r.DATA_TYPE,
        Unsigned: false,
        Nullable: r.IS_NULLABLE,
        PrimaryKey: isPrimary,
        Uuid: false,
        Ignore: false,

        // simply assumpt that integer pkeys are autoincement / auto fill  by default
        AutoIncrement: isPrimary && r.DATA_TYPE === 'int',
        Name: r.COLUMN_NAME,
        Converter: null,
        Schema: schema ? schema : this.Options.Database,
        Unique: sUnique,
      };
    });
  }

  public async transaction(queryOrCallback?: QueryBuilder[] | TransactionCallback): Promise<void> {
    if (!queryOrCallback) {
      return;
    }

    const transaction = this._connectionPool.transaction();

    await transaction.begin();

    this._transactionRequest = transaction.request();

    try {
      if (Array.isArray(queryOrCallback)) {
        for (const q of queryOrCallback) {
          await q;
        }
      } else {
        await queryOrCallback(this);
      }

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    } finally {
      this._transactionRequest = null;
    }
  }
}
