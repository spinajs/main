import { DatetimeValueConverter, DeleteQueryCompiler, ModelDehydrator, TableAliasCompiler, OnDuplicateQueryCompiler, OrderByQueryCompiler, TableQueryCompiler, ColumnQueryCompiler, InsertQueryCompiler, QueryContext, OrmDriver, IColumnDescriptor, QueryBuilder, TransactionCallback, TableExistsCompiler, LimitQueryCompiler } from '@spinajs/orm';
/* eslint-disable security/detect-object-injection */
import { Injectable } from '@spinajs/di';
import { LogLevel } from '@spinajs/log-common';

import { SqlDriver } from '@spinajs/orm-sql';
import { connect, ConnectionPool, Request } from 'mssql';
import { IIndexInfo, ITableColumnInfo } from './types';
import { MsSqlTableExistsCompiler, MsSqlLimitCompiler, MsSqlOrderByCompiler, MsSqlTableQueryCompiler, MsSqlColumnQueryCompiler, MsSqlInsertQueryCompiler, MsSqlDeleteQueryCompiler, MsSqlTableAliasCompiler, MsSqlOnDuplicateQueryCompiler } from './compilers';
import { MssqlModelDehydrator } from './dehydrator';
import { MsSqlDatetimeValueConverter } from './converters';

@Injectable('orm-driver-mssql')
export class MsSqlOrmDriver extends SqlDriver {
  protected _connectionPool: ConnectionPool = null;
  protected _executionId = 0;
  protected _transactionRequest: Request = null;
  protected _aliasSeparator = '#';

  public async execute(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const tName = `query-${this._executionId++}`;
    let finalQuery = stmt.replaceAll('`', '');

    this.Log.timeStart(`query-${tName}`);

    try {
      const req = this._transactionRequest ?? this._connectionPool.request();
      let idx = 0;
      let i = 0;

      /**
       * Brute force replacement ? for @parameters
       * MSSQL driver requires named parameters in query string
       */
      while ((idx = finalQuery.indexOf('?')) !== -1) {
        finalQuery = finalQuery.substring(0, idx) + `@p${i}` + finalQuery.substring(idx + 1, finalQuery.length);
        req.input(`p${i}`, params[i]);
        i++;
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
            RowsAffected: result.rowsAffected[0],
          };
        case QueryContext.Insert:
          return {
            RowsAffected: result.rowsAffected[0],
            LastInsertId: result.recordset[0].ID,
          };
        default:
          return result.recordset;
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
      options: {
        trustServerCertificate: (this.Options.Options?.TrustServerCertificate as boolean) ?? true,
      },
      pool: {
        max: this.Options.PoolLimit ?? 10,
        min: 0,
        idleTimeoutMillis: 3000,
      },
    });

    await this.execute(`USE ${this.Options.Database}`, [], QueryContext.Schema);

    return this;
  }

  public resolve() {
    super.resolve();

    this.Container.register(MsSqlTableExistsCompiler).as(TableExistsCompiler);
    this.Container.register(MsSqlLimitCompiler).as(LimitQueryCompiler);
    this.Container.register(MsSqlOrderByCompiler).as(OrderByQueryCompiler);
    this.Container.register(MsSqlTableQueryCompiler).as(TableQueryCompiler);
    this.Container.register(MsSqlColumnQueryCompiler).as(ColumnQueryCompiler);
    this.Container.register(MsSqlInsertQueryCompiler).as(InsertQueryCompiler);
    this.Container.register(MsSqlDeleteQueryCompiler).as(DeleteQueryCompiler);
    this.Container.register(MssqlModelDehydrator).as(ModelDehydrator);
    this.Container.register(MsSqlTableAliasCompiler).as(TableAliasCompiler);
    this.Container.register(MsSqlDatetimeValueConverter).as(DatetimeValueConverter);
    this.Container.register(MsSqlOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
  }

  public async disconnect(): Promise<OrmDriver> {
    await this._connectionPool.close();
    return this;
  }

  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    const tblInfo = (await this.execute(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? ${schema ? 'AND TABLE_CATALOG=?' : ''}`, schema ? [name, schema] : [name], QueryContext.Select)) as ITableColumnInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null;
    }

    const indexList = (await this.execute(`select C.COLUMN_NAME,T.CONSTRAINT_TYPE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS T JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE C ON C.CONSTRAINT_NAME=T.CONSTRAINT_NAME WHERE C.TABLE_NAME=? ${schema ? ' AND c.TABLE_CATALOG=?' : ''}`, schema ? [name, schema] : [name], QueryContext.Select)) as IIndexInfo[];

    return tblInfo.map((r: ITableColumnInfo) => {
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
