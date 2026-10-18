import { DatetimeValueConverter, DeleteQueryCompiler, TableAliasCompiler, OnDuplicateQueryCompiler, OrderByQueryCompiler, TableQueryCompiler, ColumnQueryCompiler, InsertQueryCompiler, QueryContext, OrmDriver, IColumnDescriptor, TableExistsCompiler, LimitQueryCompiler, IDriverOptions, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions, InSetStatement, IdentifierQuoter, TruncateTableQueryCompiler, CreateDatabaseCompiler, DropDatabaseCompiler, CreateViewCompiler, LiteralQuoter, EventQueryCompiler, DropEventQueryCompiler, ServerResponseMapper, DbServerResponse, DefaultValueBuilder, AlterTableQueryCompiler, AlterColumnQueryCompiler } from '@spinajs/orm';
/* eslint-disable security/detect-object-injection */
import { Injectable, NewInstance } from '@spinajs/di';

import { SqlDriver, SqlTruncateTableQueryCompiler, UnsupportedEventQueryCompiler, UnsupportedDropEventQueryCompiler } from '@spinajs/orm-sql';
import mssql from 'mssql';
import { IIndexInfo, ITableColumnInfo } from './types.js';
import { MsSqlTableExistsCompiler, MsSqlLimitCompiler, MsSqlOrderByCompiler, MsSqlTableQueryCompiler, MsSqlColumnQueryCompiler, MsSqlInsertQueryCompiler, MsSqlDeleteQueryCompiler, MsSqlTableAliasCompiler, MsSqlOnDuplicateQueryCompiler, MsSqlCreateDatabaseQueryCompiler, MsSqlDropDatabaseQueryCompiler, MsSqlCreateViewCompiler, MsSqlDefaultValueBuilder, MsSqlAlterTableQueryCompiler, MsSqlAlterColumnQueryCompiler } from './compilers.js';
import { BracketIdentifierQuoter, MsSqlInSetStatement, MsSqlLiteralQuoter } from './statements.js';
import { MsSqlDatetimeValueConverter } from './converters.js';

export interface IMsSqlTransactionContext extends ITransactionContext {
  transaction: mssql.Transaction;
  /** Runs the savepoint statements only. A request keeps its declared parameters, so each statement gets a fresh one. */
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

/**
 * Rewrites the first `count` `?` placeholders into `@p0..`; a statement without bindings is left alone, any `?` in it is text.
 * A `?` inside a '...' or "..." literal or a [...] identifier is text too.
 */
export function toNamedParameters(stmt: string, count: number): string {
  let out = '';
  let index = 0;
  let closing: string | null = null;

  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];

    if (closing) {
      out += ch;
      if (ch === closing) {
        // a doubled closing character is an escaped one, not the end of the literal
        if (stmt[i + 1] === closing) {
          out += stmt[++i];
        } else {
          closing = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      closing = ch;
    } else if (ch === '[') {
      closing = ']';
    } else if (ch === '?' && index < count) {
      out += `@p${index++}`;
      continue;
    }

    out += ch;
  }

  return out;
}

export class MsSqlServerResponseMapper extends ServerResponseMapper {
  public read(data: any): DbServerResponse {
    // An upsert resolves with the rows of `SELECT SCOPE_IDENTITY()`; ID is null when MERGE updated.
    if (Array.isArray(data)) {
      const id = data.length !== 0 ? data[data.length - 1]?.ID : undefined;
      return { RowsAffected: data.length, LastInsertId: typeof id === 'number' ? id : 0, Returning: [] };
    }

    return {
      RowsAffected: data?.RowsAffected ?? 0,
      LastInsertId: typeof data?.LastInsertId === 'number' ? data.LastInsertId : 0,
      Returning: [],
    };
  }
}

@Injectable('orm-driver-mssql')
@NewInstance()
export class MsSqlOrmDriver extends SqlDriver {
  protected _connectionPool: mssql.ConnectionPool = null as any;
  // `_executionId` went with the per-driver query timing master centralised, and
  // `TransactionStorage` moved up to OrmDriver so ambient-connection propagation is part of
  // the contract rather than each driver's own business.

  public readonly SupportedIsolationLevels: IsolationLevel[] = ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];

  // 2100 per RPC, a few of which tedious spends on sp_executesql itself.
  public readonly MaxBindings = 2000;

  public readonly MaxInsertRows = 1000;

  constructor(options: IDriverOptions) {
    super(Object.assign({ AliasSeparator: '#' }, options));
  }

  public async executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
    let finalQuery = stmt.replaceAll('`', '');

    // Check if we're inside a transaction context and use that request.
    // The context comes from the base driver; only this driver's `_begin` populates it, so
    // it must be narrowed from ITransactionContext to read `request`.
    const txContext = this.TransactionStorage.getStore() as IMsSqlTransactionContext | undefined;
    const req = txContext ? txContext.transaction.request() : this._connectionPool.request();

    // No try/finally here any more: it only ever existed to bracket this driver's own
    // timeStart/timeEnd logging, which master centralised into `Perf.measure('orm.query')`.
    finalQuery = toNamedParameters(finalQuery, params?.length ?? 0);
    params?.forEach((value, index) => req.input(`p${index}`, value));

    const result = await req.query(finalQuery);

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
  }

  /** 2627: a primary key or unique constraint; 2601: a unique index. */
  protected isUniqueViolation(err: unknown): boolean {
    const n = (err as { number?: unknown })?.number;
    return n === 2627 || n === 2601;
  }

  public supportedFeatures(): ISupportedFeature {
    return {
      /**
       * FALSE. This driver registers `UnsupportedEventQueryCompiler` /
       * `UnsupportedDropEventQueryCompiler`, which throw `MethodNotImplemented` rather than
       * falling through to the shared ones; it registers no table-history compiler either, and
       * that abstraction has no shared registration to fall through to (only mysql registers
       * one), so resolving it here fails in the container instead. Scheduling on this platform
       * is SQL Server Agent, and history is a temporal table; until this driver implements
       * them, claiming support only means the failure happens later and further from its cause.
       *
       * The dialect contract check is what surfaced this — it saw the shared
       * MySQL event compiler answering for a driver whose dialect is `mssql`.
       */
      events: false,
      insertReturning: false,
      // SCOPE_IDENTITY() reports the LAST identity generated in the scope, so a multi-row insert
      // cannot be walked forwards from it. MSSQL opts out of the batch key backfill.
      insertIdIsFirstOfBatch: false,
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
      const options = this.Options.Options ?? {};

      // A pool of its own: `mssql.connect()` hands every caller the one package-global pool.
      this._connectionPool = new mssql.ConnectionPool({
        user: this.Options.User,
        password: this.Options.Password,
        database: this.Options.Database,
        server: this.Options.Host!,
        port: this.Options.Port,
        requestTimeout: options.RequestTimeout,
        connectionTimeout: options.ConnectionTimeout,
        options: {
          trustServerCertificate: (options.TrustServerCertificate as boolean) ?? true,
          cryptoCredentialsDetails: options.CryptoCredentialsDetails ? options.CryptoCredentialsDetails : {},
          // set only when configured: an undefined key here would override mssql's own default
          ...(options.Encrypt !== undefined ? { encrypt: options.Encrypt as boolean } : {}),
          ...(options.InstanceName ? { instanceName: options.InstanceName as string } : {}),
        },
        pool: {
          max: this.resolvedPoolOptions().Max,
          min: this.resolvedPoolOptions().Min,
          idleTimeoutMillis: this.resolvedPoolOptions().IdleTimeout,
          acquireTimeoutMillis: this.resolvedPoolOptions().AcquireTimeout,
        },
      });

      await this._connectionPool.connect();

      await this.executeOnDb(`USE ${msSqlEscapeIdentifier(this.Options.Database!)}`, [], QueryContext.Schema);

      return this;
    } catch (err) {
      // Clean up connection pool if connection fails
      if (this._connectionPool) {
        try {
          await this._connectionPool.close();
          this._connectionPool = null as any;
        } catch (closeErr) {
          this.Log.warn({ error: closeErr, connection: this.Options.Name }, 'Error cleaning up failed MSSQL connection pool for ${connection}');
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
    this.Container.register(MsSqlServerResponseMapper).as(ServerResponseMapper);
    this.Container.register(MsSqlDefaultValueBuilder).as(DefaultValueBuilder);
    this.Container.register(MsSqlTableAliasCompiler).as(TableAliasCompiler);
    this.Container.register(MsSqlDatetimeValueConverter).as(DatetimeValueConverter);
    this.Container.register(MsSqlOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
    this.Container.register(MsSqlInSetStatement).as(InSetStatement);

    // T-SQL spells database DDL its own way - no CHARACTER SET, no IF NOT EXISTS.
    this.Container.register(MsSqlCreateDatabaseQueryCompiler).as(CreateDatabaseCompiler);
    this.Container.register(MsSqlDropDatabaseQueryCompiler).as(DropDatabaseCompiler);

    this.Container.register(MsSqlCreateViewCompiler).as(CreateViewCompiler);
    this.Container.register(MsSqlLiteralQuoter).as(LiteralQuoter);

    // Brackets, not the backticks this driver used to inherit from the shared layer.
    this.Container.register(BracketIdentifierQuoter).as(IdentifierQuoter);

    this.Container.register(MsSqlAlterTableQueryCompiler).as(AlterTableQueryCompiler);
    this.Container.register(MsSqlAlterColumnQueryCompiler).as(AlterColumnQueryCompiler);

    // `TRUNCATE TABLE` is valid T-SQL, so the shared compiler is claimed explicitly.
    // `CREATE TABLE ... LIKE` and `WITH RECURSIVE` are NOT T-SQL and are left
    // unregistered: the container then instantiates the abstract base, so those
    // features throw a TypeError instead of reaching SQL Server as MySQL syntax.
    this.Container.register(SqlTruncateTableQueryCompiler).as(TruncateTableQueryCompiler);

    // No native scheduler in this engine, and nothing is simulated in its place.
    this.Container.register(UnsupportedEventQueryCompiler).as(EventQueryCompiler);
    this.Container.register(UnsupportedDropEventQueryCompiler).as(DropEventQueryCompiler);
  }

  public async disconnect(): Promise<OrmDriver> {
    if (this._connectionPool) {
      await this._connectionPool.close();
      this._connectionPool = null as any;
    }
    return this;
  }

  /**
   * @param schema - the database (`TABLE_CATALOG`), which is what the ORM passes; the SQL Server schema comes from `Options.Schema`
   */
  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    const tableSchema = this.Options.Options?.Schema as string | undefined;
    const filter = `${schema ? ' AND TABLE_CATALOG=?' : ''}${tableSchema ? ' AND TABLE_SCHEMA=?' : ''}`;
    const filterBindings = [name, ...(schema ? [schema] : []), ...(tableSchema ? [tableSchema] : [])];

    const tblInfo = (await this.executeOnDb(
      `SELECT *, COLUMNPROPERTY(OBJECT_ID(QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME)), COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=?${filter}`,
      filterBindings,
      QueryContext.Select,
    )) as ITableColumnInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null as any;
    }

    const indexList = (await this.executeOnDb(
      `SELECT C.COLUMN_NAME,T.CONSTRAINT_TYPE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS T JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE C ON C.CONSTRAINT_NAME=T.CONSTRAINT_NAME AND C.CONSTRAINT_SCHEMA=T.CONSTRAINT_SCHEMA WHERE C.TABLE_NAME=?${filter.replace(/TABLE_/g, 'C.TABLE_')}`,
      filterBindings,
      QueryContext.Select,
    )) as IIndexInfo[];

    return tblInfo.map((r: ITableColumnInfo) => {
      const isPrimary = indexList.find((c) => c.CONSTRAINT_TYPE === 'PRIMARY KEY' && c.COLUMN_NAME === r.COLUMN_NAME) !== undefined;
      const sUnique = indexList.find((c) => c.CONSTRAINT_TYPE === 'UNIQUE' && c.COLUMN_NAME === r.COLUMN_NAME) !== undefined;
      return {
        Type: r.DATA_TYPE,
        MaxLength: r.CHARACTER_MAXIMUM_LENGTH ?? -1,
        Comment: '',
        DefaultValue: r.COLUMN_DEFAULT,
        NativeType: r.DATA_TYPE,
        Unsigned: false,
        Nullable: r.IS_NULLABLE === 'YES',
        Virtual: false,
        PrimaryKey: isPrimary,
        Uuid: false,
        Ignore: false,
        IsForeignKey: false,
        ForeignKeyDescription: null as any,
        Aggregate: false,
        AutoIncrement: r.IS_IDENTITY === 1,
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
