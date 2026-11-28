import { NotSupported } from '@spinajs/exceptions';
import { SqliteSqlExpressions } from './expressions.js';
import { createTableParts, definedColumn, modifiedDefinition } from './rebuild.js';
import { SqliteTableExistsCompiler, SqliteColumnCompiler, SqliteTableQueryCompiler, SqliteOrderByCompiler, SqliteOnDuplicateQueryCompiler, SqliteInsertQueryCompiler, SqliteTruncateTableQueryCompiler, SqliteAlterColumnQueryCompiler, SqliteCreateDatabaseQueryCompiler, SqliteDropDatabaseQueryCompiler, SqliteCreateViewCompiler, SqliteLimitQueryCompiler, SqliteIndexQueryCompiler } from './compilers.js';
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable prettier/prettier */

export * from './compilers.js';
export * from './errors.js';
export * from './statements.js';
export * from './builders.js';
export * from './converters.js';
export * from './expressions.js';
export * from './explain.js';

// Union of all three sides: AlterColumnQueryCompiler is master's, and is registered below;
// IsolationLevel / ITransactionContext / ITransactionOptions are the transaction contract from
// orm-foundation; ConnectionState / IPoolMetrics are the connection-resilience additions from
// orm-infra. QueryBuilder / TransactionCallback / ITransaction went with the old
// `{ commit, rollback }` shape.
import { ORM_DB_VALUE_CONVERTERS, DatetimeValueConverter, IColumnDescriptor, QueryContext, ColumnQueryCompiler, AlterColumnQueryCompiler, TableQueryCompiler, OrmDriver, OrderByQueryCompiler, JoinStatement, OnDuplicateQueryCompiler, InsertQueryCompiler, TableExistsCompiler, DefaultValueBuilder, TruncateTableQueryCompiler, ModelToSqlConverter, OrmException, ValueConverter, ServerResponseMapper, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions, ConnectionState, IPoolMetrics, InSetStatement, InStatement, StartsWithStatement, backoffDelay, IdentifierQuoter, LimitQueryCompiler, RecursiveQueryCompiler, AlterTableQueryCompiler, CreateDatabaseCompiler, DropDatabaseCompiler, CreateViewCompiler, LiteralQuoter, EventQueryCompiler, DropEventQueryCompiler, NowExpression, SqlExpressions, IndexQueryCompiler, Builder, AlterTableQueryBuilder, AlterColumnQueryBuilder, TableExistsQueryBuilder, ColumnAlterationType, LiveForeignKey, LiveIndex, compareByName, referentialRule, SqlDialect, RawQuery, StreamNotSupported } from '@spinajs/orm';
import { SQLITE_SQL_DIALECT } from './sql-dialect.js';
export { SQLITE_SQL_DIALECT } from './sql-dialect.js';
import sqlite3 from 'sqlite3';
import { BacktickIdentifierQuoter, SqlAlterTableQueryCompiler, SqlWithRecursiveCompiler, escapeIdentifier, SqlDriver, SqlLiteralQuoter, UnsupportedEventQueryCompiler, UnsupportedDropEventQueryCompiler } from '@spinajs/orm-sql';
import { Class, Injectable, NewInstance } from '@spinajs/di';
import { SqlLiteJoinStatement, SqliteInSetStatement, SqliteInStatement, SqliteNowExpression, SqliteStartsWithStatement } from './statements.js';
import { mapSqliteError } from './errors.js';
import { IForeignKeyList, IIndexInfo, IIndexInfoList, ITableInfo } from './types.js';
import { format } from '@spinajs/configuration';
import { SqlLiteDefaultValueBuilder } from './builders.js';
import { SqliteDatetimeValueConverter, SqliteModelToSqlConverter } from './converters.js';
import type { InsertQueryBuilder, QueryPlan } from '@spinajs/orm';
import { normalizeSqlitePlan } from './explain.js';
import { rowidKeys } from './inserted-keys.js';

export class SqliteServerResponseMapper extends ServerResponseMapper {
  /** The RETURNING rows, else SQLite's rowid rule in docs/orm-sqlite/05-inserts-and-upserts.md. */
  public insertedKeys(response: unknown, insert: InsertQueryBuilder): Array<Record<string, unknown>> | undefined {
    return this.returnedKeys(response, insert) ?? rowidKeys(this.read(response), insert);
  }

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

const quoteSqliteIdentifier = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/** `PRAGMA schema.name("argument")`, unqualified without a schema. */
const pragmaOf = (name: string, argument: string, schema?: string) => `PRAGMA ${schema ? `${quoteSqliteIdentifier(schema)}.` : ''}${name}(${quoteSqliteIdentifier(argument)})`;

const QUOTED_DEFAULT = /^'((?:[^']|'')*)'$/;
const NUMERIC_DEFAULT = /^[+-]?\d+(\.\d+)?$/;

/** `dflt_value` is the default's SQL text: a literal becomes its value, anything else ( CURRENT_TIMESTAMP, an expression ) a RawQuery. */
function parseSqliteDefault(sql: unknown): unknown {
  if (typeof sql !== 'string') return sql ?? null;
  if (/^NULL$/i.test(sql)) return null;
  const quoted = QUOTED_DEFAULT.exec(sql);
  if (quoted) return quoted[1].replace(/''/g, "'");
  if (!NUMERIC_DEFAULT.test(sql)) return RawQuery.create(sql);
  const value = Number(sql);
  // an int64 default past 2^53 keeps its digits
  return Number.isInteger(value) && !Number.isSafeInteger(value) ? sql : value;
}

// A build without foreign-key support ignores the pragma without an error, so it is read back.
function enableForeignKeys(db: sqlite3.Database): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    db.exec('PRAGMA foreign_keys = ON', (err: Error | null) => {
      if (err) {
        reject(err);
        return;
      }

      db.get('PRAGMA foreign_keys', (readErr: Error | null, row: { foreign_keys?: number } | undefined) => {
        if (readErr) {
          reject(readErr);
        } else if (row?.foreign_keys !== 1) {
          reject(new OrmException('ForeignKeys is set, but this sqlite build does not enforce foreign keys'));
        } else {
          resolve();
        }
      });
    });
  });
}

@SqlDialect(SQLITE_SQL_DIALECT)
@Injectable('orm-driver-sqlite')
@NewInstance()
export class SqliteOrmDriver extends SqlDriver {
  protected Db: sqlite3.Database;

  /**
   * Read-only handles. SQLite serializes writers at the file level no matter how many handles are
   * open, so a second WRITER handle buys nothing and invites SQLITE_BUSY; extra READ handles do
   * parallelize SELECTs. Empty for `:memory:` and anonymous temporary databases, where each handle
   * would open its own private database, and when `Pool.Max` is 1.
   */
  protected ReadPool: sqlite3.Database[] = [];

  private _readCursor = -1;

  /** Outside WAL a read in progress keeps the writer from committing, so a stream would lock out every write. */
  private _walJournal = false;

  /** Resolves when the open transaction ends; `null` while none is open. */
  private _writerGate: Promise<void> | null = null;

  private _openWriterGate: (() => void) | null = null;

  /** Writer-handle statements from outside any transaction that have not settled yet; they never reject. */
  private _outsideStatements = new Set<Promise<unknown>>();

  /**
   * sqlite3 outside shared-cache mode serializes access to the database file, which is
   * SERIALIZABLE and nothing else. Any other requested level is rejected by the base class
   * rather than silently ignored.
   */
  public readonly SupportedIsolationLevels: IsolationLevel[] = ['SERIALIZABLE'];

  /** SQLITE_MAX_VARIABLE_NUMBER of the bundled SQLite (3.32 and later). */
  public readonly MaxBindings = 32766;

  // getNextExecutionId() went with the per-driver query timing that master centralised into
  // `Perf.measure('orm.query', ...)` around SqlDriver.execute — its only caller is gone.

  /**
   * Whether a query runs on the writer handle. Everything that mutates, changes schema, or runs
   * inside a transaction stays on the single writer handle — scattering a transaction's statements
   * across handles would run them outside the transaction, and a read handle cannot see uncommitted
   * writes made on the writer. `handleFor` and the writer gate in `executeOnDb` both follow it, so
   * override this rather than `handleFor` to change the routing.
   */
  protected usesWriter(queryContext: QueryContext): boolean {
    return this.ReadPool.length === 0 || queryContext !== QueryContext.Select || this.TransactionStorage.getStore() !== undefined;
  }

  /** Picks the handle for a query: the writer when `usesWriter` says so, otherwise the next read handle. */
  protected handleFor(queryContext: QueryContext): sqlite3.Database {
    if (this.usesWriter(queryContext)) {
      return this.Db;
    }

    this._readCursor = (this._readCursor + 1) % this.ReadPool.length;
    // eslint-disable-next-line security/detect-object-injection
    return this.ReadPool[this._readCursor];
  }

  /**
   * The writer handle plus every read handle. SQLite has no queue of waiting callers — sqlite3
   * serializes internally per handle — so InUse and Waiting are always zero.
   */
  public poolMetrics(): IPoolMetrics {
    return {
      Size: this.Db ? this.ReadPool.length + 1 : 0,
      InUse: 0,
      Waiting: 0,
    };
  }

  public executeOnDb(stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    return this.withSessionSettings(() => this.gatedStatement(stmt, params, queryContext));
  }

  /**
   * Holds a writer-handle statement from outside the open transaction's async path until that
   * transaction ends: on the one writer handle it would otherwise run inside the transaction and
   * commit or roll back with it. The ones it lets through are tracked, so the next `BEGIN` waits
   * for them.
   */
  private gatedStatement(stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    if (this.TransactionStorage.getStore() !== undefined || !this.usesWriter(queryContext)) {
      return this.runStatement(stmt, params, queryContext);
    }

    if (this._writerGate !== null) {
      return this._writerGate.then(() => this.gatedStatement(stmt, params, queryContext));
    }

    const running = this.runStatement(stmt, params, queryContext);
    const settled: Promise<boolean> = running.then(
      () => this._outsideStatements.delete(settled),
      () => this._outsideStatements.delete(settled),
    );
    this._outsideStatements.add(settled);

    return running;
  }

  /** Runs a statement on its handle, never held: the driver's own transaction statements use it directly. */
  protected runStatement(stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    if (!this.Db) {
      throw new Error('cannot execute sqlite statement, no db connection avaible');
    }

    return this.withReconnect(() => this._executeOnDbOnce(this.handleFor(queryContext), stmt, params, queryContext));
  }

  /**
   * sqlite has no transport to lose: its retryable failure is SQLITE_BUSY, a lock held by another
   * connection to the file. A retry therefore waits and runs again on the same handle instead
   * of reopening the database, which for `:memory:` would throw the database away.
   */
  protected async withReconnect<R>(operation: () => Promise<R>): Promise<R> {
    const { MaxRetries, RetryDelay, MaxRetryDelay } = this.resolvedResilienceOptions();

    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (err) {
        if (attempt >= MaxRetries || !this.isRetryableError(err)) {
          throw err;
        }

        await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, RetryDelay, MaxRetryDelay)));
      }
    }
  }

  protected isRetryableError(err: unknown): boolean {
    // replaying one statement of a transaction that hit a lock is not safe; the caller rolls back
    if (this.TransactionStorage.getStore()) {
      return false;
    }

    return super.isRetryableError(err);
  }

  protected _executeOnDbOnce(handle: sqlite3.Database, stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    const queryParams = this.toDriverParams(params);
    const fail = (reject: (reason: unknown) => void, err: unknown) =>
      reject(
        mapSqliteError(
          err,
          {
            Host: this.Options.Host,
            User: this.Options.User,
            Name: this.Options.Name,
          },
          stmt,
          params ? params.join(',') : 'none',
        ),
      );

    return new Promise((resolve, reject) => {
      switch (queryContext) {
        case QueryContext.Update:
        case QueryContext.Delete:
          handle.run(stmt, ...queryParams, function (this: sqlite3.RunResult, err: unknown) {
            if (err) {
              fail(reject, err);
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
          handle.all(stmt, ...queryParams, (err: unknown, rows: unknown) => {
            if (err) {
              fail(reject, err);
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
          handle.run(stmt, ...queryParams, function (this: sqlite3.RunResult, err: unknown) {
            if (err) {
              fail(reject, err);
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
        default: {
          const done = (err: unknown) => {
            if (err) {
              fail(reject, err);
              return;
            }

            resolve(undefined);
          };

          // run() executes only the first statement of a string; exec() runs all of them but
          // cannot bind parameters
          if (queryContext === QueryContext.Schema && queryParams.length === 0) {
            handle.exec(stmt, done);
          } else {
            handle.run(stmt, ...queryParams, done);
          }
          break;
        }
      }
    });
  }

  /**
   * Steps one prepared statement on a read handle. The writer handle cannot hold one: `BEGIN` waits for a statement in
   * progress there, and the stream's next relation batch would wait for that transaction.
   */
  public async *executeStreamOnDb(stmt: string, params: unknown[], _options: { batchSize: number }): AsyncGenerator<unknown> {
    if (!this.Db) {
      throw new Error('cannot execute sqlite statement, no db connection avaible');
    }
    if (this.usesWriter(QueryContext.Select)) {
      throw new StreamNotSupported(`connection ${this.Options.Name} has no read handle to stream from`);
    }

    const handle = this.handleFor(QueryContext.Select);
    const fail = (err: unknown) => mapSqliteError(err, { Host: this.Options.Host, User: this.Options.User, Name: this.Options.Name }, stmt, params ? params.join(',') : 'none');
    const statement = await new Promise<sqlite3.Statement>((resolve, reject) => {
      const prepared: sqlite3.Statement = handle.prepare(stmt, this.toDriverParams(params), (err: Error | null) => {
        if (err) {
          prepared.finalize();
          reject(fail(err));
          return;
        }
        resolve(prepared);
      });
    });

    try {
      for (;;) {
        const row = await new Promise<unknown>((resolve, reject) => {
          statement.get((err: Error | null, r: unknown) => (err ? reject(fail(err)) : resolve(r)));
        });
        if (row === undefined) {
          return;
        }

        yield row;
      }
    } finally {
      await new Promise<void>((resolve) => statement.finalize(() => resolve()));
    }
  }

  public supportedFeatures(): ISupportedFeature {
    // a second BEGIN on the one writer handle fails, so the core queues outermost transactions
    return { events: false, insertReturning: true, nativeJson: false, concurrentTransactions: false, streaming: this.ReadPool.length > 0 && this._walJournal };
  }

  public async explain(sql: string, bindings: unknown[], rawSql = true): Promise<QueryPlan> {
    return normalizeSqlitePlan(await this.runExplain('EXPLAIN QUERY PLAN', sql, bindings, rawSql));
  }

  public async ping(): Promise<boolean> {
    if (!this.Db) {
      return false;
    }

    // straight on the handle: a health probe must neither queue behind an open transaction nor
    // retry. schema_version reads the file header, so a corrupt or foreign file fails here.
    return new Promise<boolean>((resolve) => this.Db.get('PRAGMA schema_version', (err: unknown) => resolve(!err)));
  }

  public async connect(): Promise<OrmDriver> {
    const filename = format({}, this.Options.Filename!);

    // a health-check reconnect calls connect() on an open driver; the old writer is not reused
    if (this.Db) {
      const stale = this.Db;
      this.Db = null as any;
      await new Promise<void>((resolve) => stale.close(() => resolve()));
    }

    const writer = await new Promise<sqlite3.Database>((resolve, reject) => {
      const db = new sqlite3.Database(filename, (err: unknown) => {
        if (err) {
          // Drop the handle, do NOT close it. sqlite3 never invokes the close callback for a
          // database that failed to open, so closing here left this promise unsettled and
          // `connect()` hung forever — an app pointed at a bad path, an unreadable file or a
          // missing directory waited indefinitely instead of being told SQLITE_CANTOPEN.
          // sqlite3 has already released whatever it allocated for a failed open; there is
          // nothing here for us to clean up.
          reject(err);
          return;
        }

        resolve(db);
      });
    });

    // Published only once set up: a statement must never reach a writer without its pragma.
    if (this.Options.ForeignKeys) {
      try {
        await enableForeignKeys(writer);
      } catch (err) {
        await new Promise<void>((resolve) => writer.close(() => resolve()));
        throw err;
      }
    }

    this.Db = writer;

    // read, never set: the journal mode is a persistent property of the file
    this._walJournal = await new Promise<boolean>((resolve) => this.Db.get('PRAGMA journal_mode', (err: unknown, row?: { journal_mode?: string }) => resolve(!err && row?.journal_mode === 'wal')));
    await this.openReadPool(filename);
    this.setState(ConnectionState.Connected);

    return this;
  }

  /**
   * Opens `Pool.Max - 1` read-only handles. Skipped for `:memory:` and for anonymous temporary
   * databases, where every handle gets its own private database and a read pool would query empty
   * files. A handle that fails to open is dropped rather than failing the connection — the driver
   * is fully usable on the writer alone.
   */
  protected async openReadPool(filename: string): Promise<void> {
    const max = this.resolvedPoolOptions().Max;
    const normalized = filename.trim();

    await this.closeReadPool();

    if (max <= 1 || normalized === ':memory:' || normalized === '') {
      return;
    }

    const handles = await Promise.all(
      Array.from(
        { length: max - 1 },
        () =>
          new Promise<sqlite3.Database | null>((resolve) => {
            const db = new sqlite3.Database(filename, sqlite3.OPEN_READONLY, (err: unknown) => {
              if (err) {
                this.Log.warn({ error: err, connection: this.Options.Name }, 'could not open a read-only sqlite handle for ${connection}');
                resolve(null);
                return;
              }
              resolve(db);
            });
          }),
      ),
    );

    this.ReadPool = handles.filter((h): h is sqlite3.Database => h !== null);
    this._readCursor = -1;
  }

  /** Closes every read handle. Safe to call when none are open. */
  protected async closeReadPool(): Promise<void> {
    const handles = this.ReadPool;
    this.ReadPool = [];
    this._readCursor = -1;

    await Promise.all(handles.map((db) => new Promise<void>((resolve) => db.close(() => resolve()))));
  }

  public async disconnect(): Promise<OrmDriver> {
    this.stopHealthCheck();
    this.setState(ConnectionState.Disconnected);

    await this.closeReadPool();

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
    this.Container.register(SqliteAlterColumnQueryCompiler).as(AlterColumnQueryCompiler);
    this.Container.register(SqliteTableQueryCompiler).as(TableQueryCompiler);
    this.Container.register(SqliteOrderByCompiler).as(OrderByQueryCompiler);
    this.Container.register(SqlLiteJoinStatement).as(JoinStatement);
    this.Container.register(SqliteOnDuplicateQueryCompiler).as(OnDuplicateQueryCompiler);
    this.Container.register(SqliteInsertQueryCompiler).as(InsertQueryCompiler);
    this.Container.register(SqliteTableExistsCompiler).as(TableExistsCompiler);
    this.Container.register(SqlLiteDefaultValueBuilder).as(DefaultValueBuilder);
    this.Container.register(SqliteDatetimeValueConverter).as(DatetimeValueConverter);
    this.Container.register(SqliteNowExpression).as(NowExpression);
    this.Container.register(SqliteTruncateTableQueryCompiler).as(TruncateTableQueryCompiler);
    this.Container.register(SqliteModelToSqlConverter).as(ModelToSqlConverter);
    this.Container.register(SqliteServerResponseMapper).as(ServerResponseMapper);
    this.Container.register(SqliteInSetStatement).as(InSetStatement);
    this.Container.register(SqliteInStatement).as(InStatement);
    this.Container.register(SqliteStartsWithStatement).as(StartsWithStatement);

    // Overrides the shared SQL compilers inherited from SqlDriver.resolve() - sqlite has no
    // server side database to create or drop, so these refuse instead of emitting MySQL DDL.
    this.Container.register(SqliteCreateDatabaseQueryCompiler).as(CreateDatabaseCompiler);
    this.Container.register(SqliteDropDatabaseQueryCompiler).as(DropDatabaseCompiler);
    this.Container.register(SqliteCreateViewCompiler).as(CreateViewCompiler);

    // SQLite accepts MySQL's backticks. Registered explicitly rather than inherited:
    // nothing dialect-specific is registered in the shared base any more.
    this.Container.register(BacktickIdentifierQuoter).as(IdentifierQuoter);
    this.Container.register(SqliteSqlExpressions).as(SqlExpressions);
    this.Container.register(SqliteIndexQueryCompiler).as(IndexQueryCompiler);

    // Shared implementations that happen to be valid SQLite, claimed explicitly.
    // `CREATE TABLE ... LIKE` is deliberately NOT among them: SQLite has no such
    // statement, so a table clone now fails saying so instead of sending MySQL DDL.
    this.Container.register(SqliteLimitQueryCompiler).as(LimitQueryCompiler);
    this.Container.register(SqlWithRecursiveCompiler).as(RecursiveQueryCompiler);
    this.Container.register(SqlAlterTableQueryCompiler).as(AlterTableQueryCompiler);
    this.Container.register(SqlLiteralQuoter).as(LiteralQuoter);

    // No native scheduler in this engine, and nothing is simulated in its place.
    this.Container.register(UnsupportedEventQueryCompiler).as(EventQueryCompiler);
    this.Container.register(UnsupportedDropEventQueryCompiler).as(DropEventQueryCompiler);
  }

  /** The statement that opens an outermost transaction, eg. `BEGIN IMMEDIATE TRANSACTION` in a subclass. */
  protected beginStatement(_options?: ITransactionOptions): string {
    return 'BEGIN TRANSACTION';
  }

  protected async _begin(options?: ITransactionOptions): Promise<ITransactionContext> {
    // closed before BEGIN is queued, so no outside statement can land between the two
    this._writerGate = new Promise<void>((resolve) => (this._openWriterGate = resolve));

    try {
      // sqlite3 runs the statements of one handle in parallel, so an outside statement submitted
      // before the gate closed could still run after BEGIN and join the transaction
      await Promise.all(this._outsideStatements);
      await this.runStatement(this.beginStatement(options), [], QueryContext.Transaction);
    } catch (err) {
      this.openWriterGate();
      throw err;
    }

    // sqlite3 gives us a single shared handle, so there is no per-transaction connection
    // to carry — everything on this driver already runs on the same `this.Db`.
    return { depth: 0 };
  }

  // COMMIT and ROLLBACK run outside the transaction's async context: through executeOnDb they
  // would wait for the very transaction they end.
  protected async _commit(_ctx: ITransactionContext): Promise<void> {
    await this.runStatement('COMMIT', [], QueryContext.Transaction);
  }

  protected async _rollback(_ctx: ITransactionContext): Promise<void> {
    await this.runStatement('ROLLBACK', [], QueryContext.Transaction);
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
    this.openWriterGate();
  }

  private openWriterGate(): void {
    const open = this._openWriterGate;
    this._writerGate = null;
    this._openWriterGate = null;
    open?.();
  }

  /**
   *
   * Retrieves information about specific DB table if exists. If table not exists returns null
   *
   * @param name - table name to retrieve info
   * @param _schema - optional schema name
   */
  /**
   * sqlite has no ALTER COLUMN, so a builder that modifies columns rebuilds the table as
   * https://sqlite.org/lang_altertable.html#otheralter describes: each modified definition is replaced,
   * the rest of the table, its rows, indexes and triggers are kept.
   */
  public execute(builder: Builder<any>) {
    if (builder instanceof AlterTableQueryBuilder && builder.Columns.some((c) => (c as AlterColumnQueryBuilder).AlterType === ColumnAlterationType.Modify)) {
      return this.modifyByRebuild(builder);
    }
    if (builder instanceof TableExistsQueryBuilder) {
      return this.tableExistsIfAttached(builder);
    }
    return super.execute(builder);
  }

  // `<schema>.sqlite_master` of a database that is not attached fails with "no such table"; `tableInfo()` reads such a schema as holding no table.
  private async tableExistsIfAttached(builder: TableExistsQueryBuilder): Promise<unknown> {
    return (await this.isAttached(builder.Database)) ? super.execute(builder) : [];
  }

  protected async modifyByRebuild(builder: AlterTableQueryBuilder): Promise<void> {
    const columns = builder.Columns as AlterColumnQueryBuilder[];
    if (builder.DroppedColumns.length > 0 || builder.NewTableName || columns.some((c) => c.AlterType !== ColumnAlterationType.Modify)) {
      throw new NotSupported(`sqlite modifies columns of ${builder.Table} by rebuilding it: alter them in an alterTable() of their own`);
    }

    const q = this.Container.resolve(IdentifierQuoter);
    const table = q.quote(builder.Table);
    const raw = (sql: string, bindings: unknown[] = []) => this.executeOnDb(sql, bindings, QueryContext.Select) as Promise<any[]>;

    await this.transaction(async () => {
      const [definition] = await raw(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [builder.Table]);
      if (!definition) throw new OrmException(`sqlite cannot modify columns of ${builder.Table}: no such table`);

      // With foreign keys enforced, dropping a referenced table deletes or rejects the rows that reference it.
      const [{ foreign_keys }] = await raw('PRAGMA foreign_keys');
      if (foreign_keys) {
        const tables = (await raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name <> ?`, [builder.Table])) as { name: string }[];
        for (const { name } of tables) {
          const keys = (await raw(`PRAGMA foreign_key_list(${q.quote(name)})`)) as { table: string }[];
          if (keys.some((k) => k.table.toLowerCase() === builder.Table.toLowerCase())) {
            throw new NotSupported(`sqlite cannot rebuild ${builder.Table} while foreign keys are enforced: ${name} references it`);
          }
        }
      }

      const { body, tail } = createTableParts(definition.sql);
      for (const column of columns) {
        const at = body.findIndex((d) => definedColumn(d)?.toLowerCase() === column.Name.toLowerCase());
        if (at < 0) throw new OrmException(`sqlite cannot modify column ${column.Name}: table ${builder.Table} has none`);
        const compiled = this.Container.resolve<ColumnQueryCompiler>(ColumnQueryCompiler, [column]).compile().expression as string;
        body[at] = modifiedDefinition(body[at], column, compiled);
      }

      const dependents = (await raw(`SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL`, [builder.Table])) as { sql: string }[];
      const names = ((await raw(`PRAGMA table_info(${table})`)) as { name: string }[]).map((c) => q.quote(c.name)).join(', ');
      const next = q.quote(`${builder.Table}__rebuild`);

      await raw(`CREATE TABLE ${next} (${body.join(', ')}) ${tail}`);
      await raw(`INSERT INTO ${next} (${names}) SELECT ${names} FROM ${table}`);
      await raw(`DROP TABLE ${table}`);
      await raw(`ALTER TABLE ${next} RENAME TO ${table}`);
      for (const { sql } of dependents) await raw(sql);
    });
  }

  // A write statement takes the database's RESERVED lock, which keeps every other writer out until the transaction ends.
  public async lockTableShared(table: string): Promise<void> {
    this.assertInTransaction('lockTableShared');
    await this.schema().raw(`DELETE FROM ${this.Container.resolve(IdentifierQuoter).quoteQualified(table)} WHERE 0`);
  }

  public async tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]> {
    // The map is cached by `Orm.registerDefaultConverters()`; a driver used without a booted Orm ( a bare
    // MigrationRunner's `ensureStorage()` probe, a driver resolved on its own ) has none. An empty map degrades as an
    // unrecognised column type does: `DefaultValue` keeps the raw `dflt_value`.
    const converters = this.Container.get(ORM_DB_VALUE_CONVERTERS) ?? new Map<string, Class<ValueConverter>>();

    const tblInfo = (await this.isAttached(schema)) ? ((await this.executeOnDb(`${pragmaOf('table_info', name, schema)};`, [] as any, QueryContext.Select)) as ITableInfo[]) : [];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null as any;
    }

    // only a single-column unique index makes its column unique on its own: onDuplicate() turns
    // Unique columns into the conflict target, which must match one index exactly
    const indexes = await this.readIndexes(name, schema);
    const uIndices = indexes.filter((i) => i.unique === 1 && i.columns.length === 1).map((i) => i.columns[0]);

    const foreignKeys = await this.readForeignKeys(name, schema);

    // PRAGMA table_info reports `pk` as the 1-BASED POSITION within the primary key, not a
    // boolean. Every column with pk > 0 is part of the key.
    const pkColumnCount = tblInfo.filter((r) => r.pk > 0).length;
    // Every primary key but the rowid alias has an index of origin `pk`: the automatic index of a rowid table
    // (INTEGER PRIMARY KEY DESC, any other type, a composite key) or the key of a WITHOUT ROWID table.
    const rowidAlias = pkColumnCount === 1 && !indexes.some((i) => i.origin === 'pk');

    return tblInfo.map((r: ITableInfo) => {
      const fk = foreignKeys.find((i) => i.from === r.name);
      const converter = converters.get(r.type.toLocaleLowerCase());
      const value = parseSqliteDefault(r.dflt_value);
      return {
        Type: r.type,
        MaxLength: -1,
        Comment: '',
        DefaultValue: converter && value !== null && !(value instanceof RawQuery) ? this.Container.resolve<ValueConverter>(converter).fromDB(value) : value,
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
        AutoIncrement: rowidAlias && r.pk === 1,
        Name: r.name,
        Converter: null as any,
        Schema: schema ? schema : this.Options.Database,
        Unique: uIndices.includes(r.name),
      };
    });
  }

  public async tableIndexes(name: string, schema?: string): Promise<LiveIndex[]> {
    if (!(await this.isAttached(schema))) return [];

    // PRAGMA index_info names an expression part null; it is left out, as the other drivers leave it out.
    const indexes: LiveIndex[] = (await this.readIndexes(name, schema)).map((i) => {
      const columns = i.columns.filter((c) => typeof c === 'string');
      return { name: i.name, columns, unique: i.unique === 1, primary: i.origin === 'pk', ...(columns.length < i.columns.length ? { inexact: true } : {}) };
    });

    if (!indexes.some((i) => i.primary)) {
      // An INTEGER PRIMARY KEY is the rowid itself and has no index of its own to list.
      const info = (await this.executeOnDb(pragmaOf('table_info', name, schema), [], QueryContext.Select)) as ITableInfo[];
      const key = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
      if (key.length > 0) {
        indexes.push({ name: 'PRIMARY', columns: key, unique: true, primary: true });
      }
    }

    return indexes.sort(compareByName);
  }

  // The pragma is per connection: read it on the writer handle, which runs the migrations.
  public foreignKeysEnforced(): Promise<boolean> {
    if (!this.Db) {
      throw new Error('cannot read PRAGMA foreign_keys, no db connection');
    }

    return new Promise((resolve, reject) => {
      this.Db.get('PRAGMA foreign_keys', (err: Error | null, row?: { foreign_keys: number }) => (err ? reject(err) : resolve(row?.foreign_keys === 1)));
    });
  }

  public async tableForeignKeys(name: string, schema?: string): Promise<LiveForeignKey[]> {
    if (!(await this.isAttached(schema))) return [];

    const keys = [...(await this.readForeignKeys(name, schema))].sort((a, b) => a.id - b.id || a.seq - b.seq);

    return keys.map((fk) => ({
      // sqlite keeps no constraint name in its catalog
      name: `fk_${name}_${fk.id}`,
      column: fk.from,
      table: fk.table,
      references: fk.to,
      onDelete: referentialRule(fk.on_delete),
      onUpdate: referentialRule(fk.on_update),
    }));
  }

  /**
   * A database attached after the Orm booted is unknown while it reflects its models, and a qualified pragma fails on
   * it: its tables read as missing until `reloadTableInfo()`. `temp` is not listed before its first table.
   */
  private async isAttached(schema?: string): Promise<boolean> {
    if (!schema || schema.toLowerCase() === 'temp') return true;
    const found = await this.executeOnDb('SELECT 1 FROM pragma_database_list WHERE name = ? COLLATE NOCASE', [schema], QueryContext.Select);
    return Array.isArray(found) && found.length > 0;
  }

  /** PRAGMA index_list with each index's columns in key order. */
  private async readIndexes(name: string, schema?: string): Promise<Array<IIndexInfoList & { columns: string[] }>> {
    const list = (await this.executeOnDb(pragmaOf('index_list', name, schema), [], QueryContext.Select)) as IIndexInfoList[];
    const indexes: Array<IIndexInfoList & { columns: string[] }> = [];

    for (const index of list) {
      const info = (await this.executeOnDb(pragmaOf('index_info', index.name, schema), [], QueryContext.Select)) as IIndexInfo[];
      indexes.push({ ...index, columns: [...info].sort((a, b) => a.seqno - b.seqno).map((c) => c.name) });
    }

    return indexes;
  }

  private async readForeignKeys(name: string, schema?: string): Promise<IForeignKeyList[]> {
    return (await this.executeOnDb(pragmaOf('foreign_key_list', name, schema), [], QueryContext.Select)) as IForeignKeyList[];
  }
}
