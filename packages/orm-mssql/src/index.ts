import { DatetimeValueConverter, DeleteQueryCompiler, ModelDehydrator, TableAliasCompiler, OnDuplicateQueryCompiler, OrderByQueryCompiler, TableQueryCompiler, ColumnQueryCompiler, InsertQueryCompiler, QueryContext, OrmDriver, IColumnDescriptor, TableExistsCompiler, LimitQueryCompiler, IDriverOptions, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions } from '@spinajs/orm';
/* eslint-disable security/detect-object-injection */
import { Injectable, NewInstance } from '@spinajs/di';
import { LogLevel } from '@spinajs/log-common';

import { SqlDriver } from '@spinajs/orm-sql';
import mssql from 'mssql';
import { IIndexInfo, ITableColumnInfo } from './types.js';
import { MsSqlTableExistsCompiler, MsSqlLimitCompiler, MsSqlOrderByCompiler, MsSqlTableQueryCompiler, MsSqlColumnQueryCompiler, MsSqlInsertQueryCompiler, MsSqlDeleteQueryCompiler, MsSqlTableAliasCompiler, MsSqlOnDuplicateQueryCompiler } from './compilers.js';
import { MssqlModelDehydrator } from './dehydrator.js';
import { MsSqlDatetimeValueConverter } from './converters.js';

export interface IMsSqlTransactionContext extends ITransactionContext {
  transaction: mssql.Transaction;
  request: mssql.Request;
}

const MSSQL_ISOLATION_LEVELS: Record<IsolationLevel, mssql.IIsolationLevel> = {
  'READ UNCOMMITTED': mssql.ISOLATION_LEVEL.READ_UNCOMMITTED,
  'READ COMMITTED': mssql.ISOLATION_LEVEL.READ_COMMITTED,
  'REPEATABLE READ': mssql.ISOLATION_LEVEL.REPEATABLE_READ,
  SERIALIZABLE: mssql.ISOLATION_LEVEL.SERIALIZABLE,
};

/**
 * MSSQL quotes identifiers with brackets and escapes an embedded `]` by doubling it — the
 * shared `orm-sql` helper emits backticks, which SQL Server does not understand.
 */
function msSqlEscapeIdentifier(name: string): string {
  return '[' + String(name).replace(/]/g, ']]') + ']';
}

@Injectable('orm-driver-mssql')
@NewInstance()
export class MsSqlOrmDriver extends SqlDriver {
  protected _connectionPool: mssql.ConnectionPool = null as any;
  protected _executionId = 0;

  public readonly SupportedIsolationLevels: IsolationLevel[] = ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];

  constructor(options: IDriverOptions) {
    super(Object.assign({ AliasSeparator: '#' }, options));
  }

  private getNextExecutionId(): number {
    this._executionId = (this._executionId + 1) % Number.MAX_SAFE_INTEGER;
    return this._executionId;
  }

  public async executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const tName = `query-${this.getNextExecutionId()}`;
    let finalQuery = stmt.replaceAll('`', '');

    this.Log.timeStart(`query-${tName}`);

    try {
      // Check if we're inside a transaction context and use that request.
      // The context comes from the base driver; only this driver's `_begin` populates it.
      const txContext = this.TransactionStorage.getStore() as IMsSqlTransactionContext | undefined;
      const req = txContext?.request ?? this._connectionPool.request();
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
          error: undefined,
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
            // SCOPE_IDENTITY() path; MSSQL keeps no RETURNING rows here.
            LastInsertId: result.recordset?.[0]?.ID ?? 0,
            Returning: [],
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

  public supportedFeatures(): ISupportedFeature {
    return {
      events: true,
    };
  }

  public async ping(): Promise<boolean> {
    try {
      await this.executeOnDb('SELECT 1', [], QueryContext.Select);
      return true;
    } catch {
      return false;
    }
  }

  public async connect(): Promise<OrmDriver> {
    try {
      this._connectionPool = (await mssql.connect({
        user: this.Options.User,
        password: this.Options.Password,
        database: this.Options.Database,
        server: this.Options.Host!,
        options: {
          trustServerCertificate: (this.Options.Options?.TrustServerCertificate as boolean) ?? true,
          cryptoCredentialsDetails: this.Options.Options?.CryptoCredentialsDetails ? this.Options.Options?.CryptoCredentialsDetails : {},
        },
        pool: {
          max: this.Options.PoolLimit ?? 10,
          min: 0,
          idleTimeoutMillis: 3000,
        },
      })) as mssql.ConnectionPool;

      await this.executeOnDb(`USE ${this.Options.Database}`, [], QueryContext.Schema);

      return this;
    } catch (err) {
      // Clean up connection pool if connection fails
      if (this._connectionPool) {
        try {
          await this._connectionPool.close();
          this._connectionPool = null as any;
        } catch (closeErr) {
          this.Log.warn(`Error cleaning up failed MSSQL connection pool for ${this.Options.Name}: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
        }
      }
      throw err;
    }
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
    if (this._connectionPool) {
      await this._connectionPool.close();
      this._connectionPool = null as any;
    }
    return this;
  }

  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    const tblInfo = (await this.executeOnDb(`SELECT * FROM INFORMATION_SCHEMA.COLUMNS where TABLE_NAME=? ${schema ? 'AND TABLE_CATALOG=?' : ''}`, schema ? [name, schema] : [name], QueryContext.Select)) as ITableColumnInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null as any;
    }

    const indexList = (await this.executeOnDb(`select C.COLUMN_NAME,T.CONSTRAINT_TYPE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS T JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE C ON C.CONSTRAINT_NAME=T.CONSTRAINT_NAME WHERE C.TABLE_NAME=? ${schema ? ' AND c.TABLE_CATALOG=?' : ''}`, schema ? [name, schema] : [name], QueryContext.Select)) as IIndexInfo[];

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
        Virtual: false,
        PrimaryKey: isPrimary,
        Uuid: false,
        Ignore: false,
        IsForeignKey: false,
        ForeignKeyDescription: null as any,
        Aggregate: false,

        // simply assumpt that integer pkeys are autoincement / auto fill  by default
        AutoIncrement: isPrimary && r.DATA_TYPE === 'int',
        Name: r.COLUMN_NAME,
        Converter: null as any,
        Schema: schema ? schema : this.Options.Database,
        Unique: sUnique,
      } as unknown as IColumnDescriptor;
    });
  }

  private msSqlCtx(ctx: ITransactionContext): IMsSqlTransactionContext {
    return ctx as IMsSqlTransactionContext;
  }

  protected async _begin(options?: ITransactionOptions): Promise<ITransactionContext> {
    const transaction = this._connectionPool.transaction();

    await transaction.begin(options?.isolation ? MSSQL_ISOLATION_LEVELS[options.isolation] : undefined);

    const ctx: IMsSqlTransactionContext = { transaction, request: transaction.request(), depth: 0 };
    return ctx;
  }

  protected async _commit(ctx: ITransactionContext): Promise<void> {
    await this.msSqlCtx(ctx).transaction.commit();
  }

  protected async _rollback(ctx: ITransactionContext): Promise<void> {
    await this.msSqlCtx(ctx).transaction.rollback();
  }

  // savepoint names cannot be bound parameters, so they are inlined with MSSQL's own
  // bracket quoting rather than the backtick dialect the shared SQL layer uses
  protected async _savepoint(ctx: ITransactionContext, name: string): Promise<void> {
    await this.msSqlCtx(ctx).request.query(`SAVE TRANSACTION ${msSqlEscapeIdentifier(name)}`);
  }

  protected async _releaseSavepoint(_ctx: ITransactionContext, _name: string): Promise<void> {
    // MSSQL has no RELEASE SAVEPOINT: a save point simply stops being reachable once the
    // enclosing transaction commits. Nothing to do, but the contract requires the hook.
  }

  protected async _rollbackToSavepoint(ctx: ITransactionContext, name: string): Promise<void> {
    await this.msSqlCtx(ctx).request.query(`ROLLBACK TRANSACTION ${msSqlEscapeIdentifier(name)}`);
  }

  protected async _dispose(_ctx: ITransactionContext): Promise<void> {
    // no-op: `mssql` owns the pooling and reclaims the transaction's connection itself
  }
}
