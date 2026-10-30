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

// Union of all three sides: AlterColumnQueryCompiler is master's, and is registered below;
// IsolationLevel / ITransactionContext / ITransactionOptions are the transaction contract from
// orm-foundation; ConnectionState / IPoolMetrics are the connection-resilience additions from
// orm-infra. QueryBuilder / TransactionCallback / ITransaction went with the old
// `{ commit, rollback }` shape.
import { ORM_DB_VALUE_CONVERTERS, DatetimeValueConverter, IColumnDescriptor, QueryContext, ColumnQueryCompiler, AlterColumnQueryCompiler, TableQueryCompiler, OrmDriver, OrderByQueryCompiler, JoinStatement, OnDuplicateQueryCompiler, InsertQueryCompiler, TableExistsCompiler, DefaultValueBuilder, TruncateTableQueryCompiler, ModelToSqlConverter, OrmException, ValueConverter, ServerResponseMapper, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions, ConnectionState, IPoolMetrics, InSetStatement, InStatement, StartsWithStatement, backoffDelay, IdentifierQuoter, LimitQueryCompiler, RecursiveQueryCompiler, AlterTableQueryCompiler, CreateDatabaseCompiler, DropDatabaseCompiler, CreateViewCompiler, LiteralQuoter, EventQueryCompiler, DropEventQueryCompiler, NowExpression, SqlExpressions, IndexQueryCompiler, Builder, AlterTableQueryBuilder, AlterColumnQueryBuilder, ColumnAlterationType } from '@spinajs/orm';
import sqlite3 from 'sqlite3';
import { BacktickIdentifierQuoter, SqlAlterTableQueryCompiler, SqlWithRecursiveCompiler, escapeIdentifier, SqlDriver, SqlLiteralQuoter, UnsupportedEventQueryCompiler, UnsupportedDropEventQueryCompiler, IsoDatetimeValueConverter } from '@spinajs/orm-sql';
import { Class, Injectable, NewInstance } from '@spinajs/di';
import { SqlLiteJoinStatement, SqliteInSetStatement, SqliteInStatement, SqliteNowExpression, SqliteStartsWithStatement } from './statements.js';
import { mapSqliteError } from './errors.js';
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
  protected Db: sqlite3.Database;

  /**
   * Read-only handles. SQLite serializes writers at the file level no matter how many handles are
   * open, so a second WRITER handle buys nothing and invites SQLITE_BUSY; extra READ handles do
   * parallelize SELECTs. Empty for `:memory:` and anonymous temporary databases, where each handle
   * would open its own private database, and when `Pool.Max` is 1.
   */
  protected ReadPool: sqlite3.Database[] = [];

  private _readCursor = -1;

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

  /**
   * Holds a writer-handle statement from outside the open transaction's async path until that
   * transaction ends: on the one writer handle it would otherwise run inside the transaction and
   * commit or roll back with it. The ones it lets through are tracked, so the next `BEGIN` waits
   * for them.
   */
  public executeOnDb(stmt: string, params: unknown[], queryContext: QueryContext): Promise<unknown> {
    if (this.TransactionStorage.getStore() !== undefined || !this.usesWriter(queryContext)) {
      return this.runStatement(stmt, params, queryContext);
    }

    if (this._writerGate !== null) {
      return this._writerGate.then(() => this.executeOnDb(stmt, params, queryContext));
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

  public supportedFeatures(): ISupportedFeature {
    // insertIdIsFirstOfBatch is false: sqlite3's `lastID` is the LAST rowid the statement
    // produced, not the first. SQLite does not need it — it gets every key from RETURNING.
    // a second BEGIN on the one writer handle fails, so the core queues outermost transactions
    return { events: false, insertReturning: true, insertIdIsFirstOfBatch: false, nativeJson: false, concurrentTransactions: false };
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

    await new Promise<void>((resolve, reject) => {
      this.Db = new sqlite3.Database(filename, (err: unknown) => {
        if (err) {
          // Drop the handle, do NOT close it. sqlite3 never invokes the close callback for a
          // database that failed to open, so closing here left this promise unsettled and
          // `connect()` hung forever — an app pointed at a bad path, an unreadable file or a
          // missing directory waited indefinitely instead of being told SQLITE_CANTOPEN.
          // sqlite3 has already released whatever it allocated for a failed open; there is
          // nothing here for us to clean up.
          this.Db = null as any;
          reject(err);
          return;
        }

        resolve();
      });
    });

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
    this.Container.register(IsoDatetimeValueConverter).as(DatetimeValueConverter);
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
    return super.execute(builder);
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

  public async tableInfo(name: string, _schema?: string): Promise<IColumnDescriptor[]> {
    // An absent converter map is a normal state here, not a bug to assert away. The map lives in
    // the container CACHE and is put there by `Orm.registerDefaultConverters()`, which runs AFTER
    // the boot migration pass - and the migration service calls `tableInfo` from `ensureStorage()`
    // to find out which tracking columns an EXISTING table is missing. So the first `tableInfo` of
    // a boot against an already-migrated database arrives before any converter exists, and the `!`
    // that used to stand here turned that into `Cannot read properties of undefined (reading
    // 'get')` - a crash on every restart, invisible on the first boot because a table that had to
    // be created skips the probe entirely.
    //
    // Falling back to an empty map degrades exactly as an unrecognised column type already does:
    // `DefaultValue` keeps the raw `dflt_value` sqlite reported.
    const converters = this.Container.get(ORM_DB_VALUE_CONVERTERS) ?? new Map<string, Class<ValueConverter>>();

    const quoted = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

    const tblInfo = (await this.executeOnDb(`PRAGMA table_info(${quoted(name)});`, [] as any, QueryContext.Select)) as ITableInfo[];

    if (!tblInfo || !Array.isArray(tblInfo) || tblInfo.length === 0) {
      return null as any;
    }

    // get all indices for table
    const indexList = (await this.executeOnDb(`PRAGMA index_list(${quoted(name)})`, [] as any, QueryContext.Select)) as IIndexInfoList[];
    const uIndices: string[] = [];

    // only a single-column unique index makes its column unique on its own: onDuplicate() turns
    // Unique columns into the conflict target, which must match one index exactly
    for (const idx of indexList.filter((i) => i.unique === 1)) {
      const iInfo = (await this.executeOnDb(`PRAGMA index_info(${quoted(idx.name)})`, [] as any, QueryContext.Select)) as IIndexInfo[];
      if (iInfo.length === 1) {
        uIndices.push(iInfo[0].name);
      }
    }

    // get all foreign keys
    const foreignKeys = (await this.executeOnDb(`PRAGMA foreign_key_list(${quoted(name)})`, [] as any, QueryContext.Select)) as IForeignKeyList[];

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
        DefaultValue: converter ? this.Container.resolve<ValueConverter>(converter).fromDB(r.dflt_value) : r.dflt_value,
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
        Unique: uIndices.includes(r.name),
      };
    });
  }
}
