/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, NewInstance } from '@spinajs/di';
import { QueryContext, OrmDriver, IColumnDescriptor, TableExistsCompiler, OrmException, ServerResponseMapper, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions, ConnectionState, IPoolMetrics, IdentifierQuoter, OnDuplicateQueryCompiler, ColumnQueryCompiler, AlterColumnQueryCompiler, AlterTableQueryCompiler, LimitQueryCompiler, TruncateTableQueryCompiler, RecursiveQueryCompiler, DefaultValueBuilder, InsertQueryCompiler, CreateDatabaseCompiler, DropDatabaseCompiler } from '@spinajs/orm';
import { SqlDriver, SqlTruncateTableQueryCompiler, SqlWithRecursiveCompiler, SqlAlterTableQueryCompiler, SqlDropDatabaseQueryCompiler } from '@spinajs/orm-sql';
import pg from 'pg';
import { PostgresTableExistsCompiler, PostgresLimitQueryCompiler, PostgresOnDuplicateQueryCompiler, PostgresInsertQueryCompiler, PostgresColumnQueryCompiler, PostgresAlterColumnQueryCompiler, PostgresCreateDatabaseQueryCompiler, PostgresDefaultValueBuilder } from './compilers.js';
import { DoubleQuoteIdentifierQuoter, pgEscapeIdentifier } from './statements.js';
import { ITableColumnInfo, IConstraintInfo } from './types.js';

export * from './compilers.js';
export * from './statements.js';

export interface IPostgresTransactionContext extends ITransactionContext {
  connection: pg.PoolClient;
}

/**
 * SQLSTATE classes that mean the transport died rather than the statement being wrong.
 * 08xxx is the connection-exception class; 57P01–57P03 are the server telling us it is
 * going away ( admin shutdown, crash shutdown, cannot connect now ).
 */
const PG_RETRYABLE_CODES = new Set(['08000', '08001', '08003', '08004', '08006', '08007', '57P01', '57P02', '57P03']);

/**
 * Rewrites the `?` placeholders every compiler emits into the `$1..$n` positional
 * parameters the pg protocol requires. Same brute-force walk the MSSQL driver does for
 * its `@p` parameters — the compilers bind every user value, so a literal `?` does not
 * appear in generated SQL outside of a placeholder position.
 */
export function toPositionalParameters(stmt: string): string {
  let i = 0;
  return stmt.replace(/\?/g, () => `$${++i}`);
}

export class PostgresServerResponseMapper extends ServerResponseMapper {
  public read(data: any, pkNames?: string[]) {
    // Upserts resolve with their RETURNING rows directly.
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

    // A RETURNING insert arrives normalized by executeOnDb, carrying its rows; a plain
    // run carries none. Passing the rows through is what lets the caller read generated keys.
    return {
      RowsAffected: data?.RowsAffected ?? 0,
      LastInsertId: data?.LastInsertId ?? 0,
      Returning: Array.isArray(data?.Returning) ? data.Returning : ([] as any[]),
    };
  }
}

@Injectable('orm-driver-postgres')
@NewInstance()
export class PostgresOrmDriver extends SqlDriver {
  protected Pool: pg.Pool;

  /**
   * Postgres parses all four standard levels; READ UNCOMMITTED is accepted and behaves as
   * READ COMMITTED, which is the standard-permitted upgrade, so it is not refused here.
   */
  public readonly SupportedIsolationLevels: IsolationLevel[] = ['READ UNCOMMITTED', 'READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'];

  /**
   * pg hands NUMERIC/DECIMAL and BIGINT back as STRINGS: both can exceed 2^53, where a
   * float loses exactly the precision those types exist to keep, so node-postgres refuses
   * to guess. No converter along the way changes that, so the RESPONSE schema has to say
   * the same thing as the runtime. Reads only — on the request side these stay numbers.
   */
  public readonly ResponseSchemaTypes: Readonly<Record<string, unknown>> = {
    decimal: { type: 'string' },
    numeric: { type: 'string' },
    bigint: { type: 'string' },
  };

  public executeOnDb(stmt: string, params: any[], context: QueryContext): Promise<any> {
    // Reads and writes are both retried: `withReconnect` only re-runs on transport
    // failures, where the statement provably never reached the server.
    return this.withReconnect(() => this._executeOnDbOnce(stmt, params, context));
  }

  protected isRetryableError(err: unknown): boolean {
    // Inside a transaction the connection carried uncommitted state. Reconnecting and
    // replaying one statement would silently apply it OUTSIDE the transaction.
    if (this.TransactionStorage.getStore()) {
      return false;
    }

    if (super.isRetryableError(err)) {
      return true;
    }

    let current: any = err;
    let depth = 0;
    while (current && depth < 5) {
      if (typeof current.code === 'string' && PG_RETRYABLE_CODES.has(current.code)) {
        return true;
      }
      current = current.inner ?? current.cause;
      depth++;
    }

    return false;
  }

  protected async _executeOnDbOnce(stmt: string, params: any[], context: QueryContext): Promise<any> {
    const finalQuery = toPositionalParameters(stmt);

    // The context comes from the base driver; only this driver's `_begin` ever populates
    // it, and it always puts a PoolClient in.
    const txContext = this.TransactionStorage.getStore() as IPostgresTransactionContext | undefined;

    try {
      let result: pg.QueryResult;

      if (txContext?.connection) {
        // A transaction owns its client for its whole lifetime — statements must never
        // land on another pooled connection.
        result = await txContext.connection.query(finalQuery, params);
      } else {
        // Taking the client explicitly, instead of letting `Pool.query` do it out of
        // sight, is what makes `orm_pool_acquire_seconds` a real number instead of zero.
        const acquireStart = process.hrtime.bigint();
        const client = await this.Pool.connect();
        this.observeAcquireSeconds(Number(process.hrtime.bigint() - acquireStart) / 1e9);

        try {
          result = await client.query(finalQuery, params);
        } finally {
          client.release();
        }
      }

      switch (context) {
        case QueryContext.Update:
        case QueryContext.Delete:
          return {
            RowsAffected: result.rowCount ?? 0,
          };
        case QueryContext.Insert:
        case QueryContext.Upsert:
        case QueryContext.InsertReturning:
          // Postgres has no LAST_INSERT_ID counter at all — generated keys travel in the
          // RETURNING rows, which insertReturning: true makes the ORM ask for.
          return {
            RowsAffected: result.rowCount ?? result.rows.length,
            LastInsertId: 0,
            Returning: result.rows ?? [],
          };
        default:
          return result.rows;
      }
    } catch (err) {
      throw new OrmException(
        `Error executing orm command `,
        {
          Host: this.Options.Host,
          User: this.Options.User,
          Name: this.Options.Name,
        },
        stmt,
        params,
        err,
      );
    }
  }

  public supportedFeatures(): ISupportedFeature {
    return {
      // No CREATE EVENT and no shared trigger dialect: scheduling on postgres is
      // pg_cron / external, and claiming support would only move the failure further
      // from its cause.
      events: false,
      insertReturning: true,
      // With RETURNING every key comes back per row; the LAST_INSERT_ID batch walk is
      // MySQL's workaround for not having it.
      insertIdIsFirstOfBatch: false,
    };
  }

  public resolve() {
    super.resolve();

    this.Container.register(PostgresTableExistsCompiler).as(TableExistsCompiler);
    this.Container.register(PostgresServerResponseMapper).as(ServerResponseMapper);

    /**
     * The postgres dialect. Every class that would otherwise arrive from the shared
     * `orm-sql` layer speaking MySQL is either replaced with the postgres spelling or —
     * when the shared SQL happens to be valid postgres — claimed explicitly, so nothing
     * dialect-specific is inherited by accident.
     */
    this.Container.register(DoubleQuoteIdentifierQuoter).as(IdentifierQuoter);
    this.Container.register(PostgresOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
    this.Container.register(PostgresInsertQueryCompiler).as(InsertQueryCompiler);
    this.Container.register(PostgresColumnQueryCompiler).as(ColumnQueryCompiler);
    this.Container.register(PostgresAlterColumnQueryCompiler).as(AlterColumnQueryCompiler);
    this.Container.register(PostgresLimitQueryCompiler).as(LimitQueryCompiler);
    this.Container.register(PostgresCreateDatabaseQueryCompiler).as(CreateDatabaseCompiler);
    this.Container.register(PostgresDefaultValueBuilder).as(DefaultValueBuilder);

    // Shared implementations that happen to be valid postgres, claimed explicitly.
    // DROP DATABASE IF EXISTS is among them: with this driver's quoter injected the
    // shared compiler already emits exactly the postgres statement.
    // `CREATE TABLE ... LIKE`, `CREATE EVENT`, MySQL trigger syntax and `CHANGE COLUMN`
    // are NOT among them and stay unregistered: those features fail with a DI error
    // naming the abstraction instead of reaching postgres as MySQL syntax.
    this.Container.register(SqlDropDatabaseQueryCompiler).as(DropDatabaseCompiler);
    this.Container.register(SqlTruncateTableQueryCompiler).as(TruncateTableQueryCompiler);
    this.Container.register(SqlWithRecursiveCompiler).as(RecursiveQueryCompiler);
    this.Container.register(SqlAlterTableQueryCompiler).as(AlterTableQueryCompiler);
  }

  /** pg.Pool publishes its bookkeeping — no private-field spelunking needed here. */
  public poolMetrics(): IPoolMetrics {
    return {
      Size: this.Pool?.totalCount ?? 0,
      InUse: Math.max((this.Pool?.totalCount ?? 0) - (this.Pool?.idleCount ?? 0), 0),
      Waiting: this.Pool?.waitingCount ?? 0,
    };
  }

  public async ping(): Promise<boolean> {
    try {
      // deliberately bypasses `withReconnect` — a health probe that reconnects on its own
      // would turn one dead connection into a reconnect storm on every tick.
      await this._executeOnDbOnce('SELECT 1', [], QueryContext.Select);
      return true;
    } catch {
      return false;
    }
  }

  public async connect(): Promise<OrmDriver> {
    const pool = this.resolvedPoolOptions();

    this.Pool = new pg.Pool({
      host: this.Options.Host,
      user: this.Options.User,
      password: this.Options.Password,
      port: this.Options.Port,
      database: this.Options.Database,
      max: pool.Max,
      min: pool.Min,
      idleTimeoutMillis: pool.IdleTimeout,
      connectionTimeoutMillis: pool.AcquireTimeout,
    });

    // An idle client's connection can die between checkouts; without a listener pg emits
    // 'error' on the pool and an unhandled 'error' event kills the process.
    this.Pool.on('error', (err) => {
      this.Log?.warn(`postgres pool connection error for ${this.Options.Name}: ${err.message}`);
    });

    try {
      // Test the pool, and pin the schema when one is configured: search_path is a
      // session setting, so it has to be set per connection as the pool opens them.
      const client = await this.Pool.connect();
      client.release();

      const schema = this.Options.Options?.Schema as string | undefined;
      if (schema) {
        this.Pool.on('connect', (c) => {
          c.query(`SET search_path TO ${pgEscapeIdentifier(schema)}`).catch((err: Error) => {
            this.Log?.warn(`could not set search_path to ${schema} for ${this.Options.Name}: ${err.message}`);
          });
        });
        // the test client above predates the listener
        await this.executeOnDb(`SET search_path TO ${pgEscapeIdentifier(schema)}`, [], QueryContext.Schema);
      }

      this.setState(ConnectionState.Connected);
      return this;
    } catch (err) {
      await this.Pool.end().catch(() => undefined);
      this.Pool = null as any;
      throw err;
    }
  }

  public async disconnect(): Promise<OrmDriver> {
    this.stopHealthCheck();
    this.setState(ConnectionState.Disconnected);

    if (this.Pool) {
      await this.Pool.end();
      this.Pool = null as any;
    }

    return this;
  }

  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    const dbSchema = schema ?? (this.Options.Options?.Schema as string | undefined) ?? 'public';

    // ORDER BY ordinal_position is not decoration: column order is part of what a table
    // descriptor means, and without it postgres is free to return rows in any order.
    const tblInfo = (await this.executeOnDb(
      `SELECT column_name, data_type, udt_name, is_nullable, column_default, is_identity
       FROM information_schema.columns
       WHERE table_name = ? AND table_schema = ?
       ORDER BY ordinal_position`,
      [name, dbSchema],
      QueryContext.Select,
    )) as ITableColumnInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null as any;
    }

    const constraints = (await this.executeOnDb(
      `SELECT kcu.column_name, tc.constraint_type
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       WHERE tc.table_name = ? AND tc.table_schema = ?`,
      [name, dbSchema],
      QueryContext.Select,
    )) as IConstraintInfo[];

    return tblInfo.map((r: ITableColumnInfo) => {
      const isPrimary = constraints.find((c) => c.constraint_type === 'PRIMARY KEY' && c.column_name === r.column_name) !== undefined;
      const isUnique = constraints.find((c) => c.constraint_type === 'UNIQUE' && c.column_name === r.column_name) !== undefined;

      return {
        // udt_name is the concrete type ( int4, varchar, numeric ); data_type spells the
        // standard name ( "character varying" ) that nothing downstream recognises.
        Type: r.udt_name,
        MaxLength: -1,
        Comment: '',
        DefaultValue: r.column_default,
        NativeType: r.udt_name,
        Unsigned: false,
        Nullable: r.is_nullable === 'YES',
        PrimaryKey: isPrimary,
        Uuid: false,
        Ignore: false,
        IsForeignKey: false,
        Virtual: false,
        ForeignKeyDescription: null as any,
        // identity is postgres 10+; nextval() in the default is the legacy SERIAL spelling
        AutoIncrement: r.is_identity === 'YES' || (r.column_default ?? '').startsWith('nextval('),
        Name: r.column_name,
        Aggregate: false,
        Converter: null as any,
        Schema: dbSchema,
        Unique: isUnique,
      };
    });
  }

  /**
   * Pulls the pooled client out of a transaction context. The base class only ever hands
   * us contexts this driver's own `_begin` produced.
   */
  private txConnection(ctx: ITransactionContext): pg.PoolClient {
    return (ctx as IPostgresTransactionContext).connection;
  }

  protected async _begin(options?: ITransactionOptions): Promise<ITransactionContext> {
    const connection = await this.Pool.connect();

    try {
      await connection.query('BEGIN');

      if (options?.isolation) {
        // Unlike MySQL, postgres sets the level INSIDE the transaction. The level is a
        // fixed, validated enum — never caller-supplied free text.
        await connection.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation}`);
      }

      return { connection, depth: 0 };
    } catch (err) {
      connection.release();
      throw err;
    }
  }

  protected async _commit(ctx: ITransactionContext): Promise<void> {
    await this.txConnection(ctx).query('COMMIT');
  }

  protected async _rollback(ctx: ITransactionContext): Promise<void> {
    await this.txConnection(ctx).query('ROLLBACK');
  }

  // savepoint names cannot be bound parameters, so they are inlined through this driver's
  // own identifier escaper rather than passed as `?`
  protected async _savepoint(ctx: ITransactionContext, name: string): Promise<void> {
    await this.txConnection(ctx).query(`SAVEPOINT ${pgEscapeIdentifier(name)}`);
  }

  protected async _releaseSavepoint(ctx: ITransactionContext, name: string): Promise<void> {
    await this.txConnection(ctx).query(`RELEASE SAVEPOINT ${pgEscapeIdentifier(name)}`);
  }

  protected async _rollbackToSavepoint(ctx: ITransactionContext, name: string): Promise<void> {
    await this.txConnection(ctx).query(`ROLLBACK TO SAVEPOINT ${pgEscapeIdentifier(name)}`);
  }

  protected _dispose(ctx: ITransactionContext): Promise<void> {
    this.txConnection(ctx).release();
    return Promise.resolve();
  }
}
