import { Log } from '@spinajs/log-common';
/* eslint-disable prettier/prettier */
import { IColumnDescriptor, IDriverOptions, IPoolOptions, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions, ModelToSqlConverter, ObjectToSqlConverter } from './interfaces.js';
import { SyncService, IContainer, DI, Container, Autoinject } from '@spinajs/di';
import { UpdateQueryBuilder, SelectQueryBuilder, IndexQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder, SchemaQueryBuilder, TruncateTableQueryBuilder, Builder } from './builders.js';
import { JsonValueConverter, StandardModelToSqlConverter, StandardObjectToSqlConverter, UniversalValueConverter, UuidConverter } from './converters.js';
import { OrmException } from './exceptions.js';
import { AsyncLocalStorage } from 'async_hooks';
import { backoffDelay, ConnectionState, delay, IConnectionResilienceOptions, isRetryableErrorCode } from './resilience.js';
import { IPoolMetrics, ORM_METRIC_KEY_ACQUIRE_SECONDS, ORM_METRIC_KEY_CONNECTION_STATE, ORM_METRIC_KEY_POOL_IN_USE, ORM_METRIC_KEY_POOL_SIZE, ORM_METRIC_KEY_POOL_WAITING, ormGauge, ormHistogram, ormMetrics } from './metrics.js';
import './hydrators.js';
import './dehydrators.js';

/**
 * Body of a transaction. Whatever it resolves with becomes the result of `transaction()`.
 */
export type TransactionCallback<R = any> = (driver: OrmDriver) => Promise<R>;

export abstract class OrmDriver<T extends IDriverOptions = IDriverOptions> extends SyncService {
  /**
   * Connection options
   */
  public Options: T = {
    AliasSeparator: '$',
    Driver: 'unknown',
    Name: 'orm-driver',
    DefaultConnection: false,
  } as T;

  public Container: IContainer;

  @Autoinject()
  protected RootContainer: Container;

  protected Log: Log;

  /**
   * Ambient transaction context.
   *
   * Statements executed inside a `transaction()` callback must run on that transaction's
   * connection. This lives on the abstract driver — rather than being a MySQL implementation
   * detail, as it used to be — so the guarantee is part of the contract and every driver
   * inherits it.
   */
  protected TransactionStorage = new AsyncLocalStorage<ITransactionContext>();

  /**
   * Isolation levels this driver honours. Empty by default: a driver that declares nothing
   * rejects every explicitly requested isolation level rather than quietly ignoring it.
   */
  public readonly SupportedIsolationLevels: IsolationLevel[] = [];

  /**
   * JSON-schema shapes for SQL types this driver hands back as something other than what
   * @spinajs/orm's shared map assumes, keyed by the same `IColumnDescriptor.Type` string.
   * Applied only to the RESPONSE schema - what a client may send is unaffected.
   *
   * Empty by default, because "how does this type arrive in JS" is a driver fact and only
   * the driver knows it: mysql2 returns DECIMAL as a string ( decimalNumbers off, so values
   * above 2^53 keep the precision DECIMAL exists for ), while tedious and sqlite return
   * numbers. Encoding any one of those answers in the shared map makes the generated
   * documentation lie for every other driver.
   */
  public readonly ResponseSchemaTypes: Readonly<Record<string, unknown>> = {};

  /**
   * The transaction currently in scope on this async execution path, or `undefined` outside
   * a transaction.
   */
  public get CurrentTransaction(): ITransactionContext | undefined {
    return this.TransactionStorage.getStore();
  }

  constructor(options: T) {
    super();
    this.Options = Object.assign(this.Options, options);
  }

  /**
   * Executes query on database
   *
   * @param stmt - query string or query objects that is executed in database
   * @param params - binding parameters
   * @param context - query context to optimize queries sent to DB
   */
  //public abstract execute(stmt: string | object, params: any[], context: QueryContext): Promise<any[] | any>;
  public abstract execute(builder: Builder<any>): Promise<any[] | any>;

  /**
   * Checks if database is avaible
   * @returns false if cannot reach database
   */
  public abstract ping(): Promise<boolean>;

  /**
   * Connects to database
   * @throws OrmException if can't connec to to database
   */
  public abstract connect(): Promise<OrmDriver>;

  /**
   * Disconnects from database
   */
  public abstract disconnect(): Promise<OrmDriver>;

  /**
   * Get list of supported features for this connection
   */
  public abstract supportedFeatures(): ISupportedFeature;

  public abstract tableInfo(name: string, schema?: string): Promise<IColumnDescriptor[]>;

  public resolve() {
    this.Log = DI.resolve(Log, [`orm-driver-${this.Options.Name}`]);
    this.Log.addVariable('orm-name', this.Options.Name);
    this.Log.addVariable('orm-host', this.Options.Host);
    this.Log.addVariable('orm-database', this.Options.Database);

    this.Container = this.RootContainer.child();
    this.Container.register(StandardModelToSqlConverter).as(ModelToSqlConverter);
    this.Container.register(StandardObjectToSqlConverter).as(ObjectToSqlConverter);
    this.Container.register(JsonValueConverter).as(JsonValueConverter);
    this.Container.register(UuidConverter).as(UuidConverter);
    this.Container.register(UniversalValueConverter).as(UniversalValueConverter);
  }

  /**
   * Effective pool settings: `Pool.*` when given, then the deprecated `PoolLimit` for `Max`,
   * then the defaults. Resolved in one place so every driver agrees on what "unset" means.
   */
  protected resolvedPoolOptions(): Required<IPoolOptions> {
    const pool = this.Options.Pool ?? {};

    return {
      Min: pool.Min ?? 0,
      Max: pool.Max ?? this.Options.PoolLimit ?? 10,
      IdleTimeout: pool.IdleTimeout ?? 30000,
      AcquireTimeout: pool.AcquireTimeout ?? 10000,
    };
  }

  private _state: ConnectionState = ConnectionState.Disconnected;

  /**
   * Current connection lifecycle state.
   */
  public get State(): ConnectionState {
    return this._state;
  }

  /**
   * Records a state transition and logs it. Repeat transitions to the same state are ignored.
   */
  protected setState(state: ConnectionState): void {
    if (this._state === state) {
      return;
    }

    const previous = this._state;
    this._state = state;

    if (state === ConnectionState.Connected) {
      this.Log.info(`connection ${this.Options.Name} is ${state} (was ${previous})`);
    } else if (state === ConnectionState.Degraded || state === ConnectionState.Disconnected) {
      this.Log.warn(`connection ${this.Options.Name} is ${state} (was ${previous})`);
    } else {
      this.Log.trace(`connection ${this.Options.Name} is ${state} (was ${previous})`);
    }
  }

  /**
   * Effective resilience settings with defaults applied.
   */
  protected resolvedResilienceOptions(): Required<IConnectionResilienceOptions> {
    const r = this.Options.Resilience ?? {};

    return {
      HealthCheckInterval: r.HealthCheckInterval ?? 30000,
      MaxRetries: r.MaxRetries ?? 5,
      RetryDelay: r.RetryDelay ?? 200,
      MaxRetryDelay: r.MaxRetryDelay ?? 5000,
    };
  }

  /**
   * True when the error means the transport died rather than the statement being wrong.
   * Drivers override to add dialect-specific codes.
   */
  protected isRetryableError(err: unknown): boolean {
    return isRetryableErrorCode(err);
  }

  /**
   * Runs `operation`, and on a retryable transport failure reconnects and retries with bounded
   * exponential backoff. Query errors propagate on the first attempt untouched.
   */
  protected async withReconnect<R>(operation: () => Promise<R>): Promise<R> {
    const { MaxRetries, RetryDelay, MaxRetryDelay } = this.resolvedResilienceOptions();
    let lastError: unknown;

    for (let attempt = 0; attempt <= MaxRetries; attempt++) {
      try {
        const result = await operation();
        this.setState(ConnectionState.Connected);
        return result;
      } catch (err) {
        if (!this.isRetryableError(err)) {
          throw err;
        }

        lastError = err;
        this.setState(ConnectionState.Degraded);

        if (attempt === MaxRetries) {
          break;
        }

        const wait = backoffDelay(attempt, RetryDelay, MaxRetryDelay);
        this.Log.warn(`connection ${this.Options.Name} lost (${(err as Error).message}); reconnect attempt ${attempt + 1}/${MaxRetries} in ${wait}ms`);
        await delay(wait);

        try {
          this.setState(ConnectionState.Connecting);
          await this.connect();
        } catch (reconnectErr) {
          this.Log.warn(`reconnect attempt ${attempt + 1} for ${this.Options.Name} failed: ${(reconnectErr as Error).message}`);
          this.setState(ConnectionState.Degraded);
        }
      }
    }

    this.setState(ConnectionState.Disconnected);
    throw lastError;
  }

  private _healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Starts the periodic health probe. Replaces the single startup `ping()` — a connection that
   * was healthy at boot tells you nothing about a pool holding sockets to a database that has
   * since restarted. No-op when `Resilience.HealthCheckInterval` is 0. Idempotent.
   */
  public startHealthCheck(): void {
    const { HealthCheckInterval } = this.resolvedResilienceOptions();

    if (HealthCheckInterval <= 0 || this._healthCheckTimer !== null) {
      return;
    }

    this._healthCheckTimer = setInterval(() => {
      void this.runHealthCheck();
    }, HealthCheckInterval);

    // Never hold the process open just to probe a database.
    if (typeof (this._healthCheckTimer as any).unref === 'function') {
      (this._healthCheckTimer as any).unref();
    }
  }

  /**
   * Stops the periodic health probe. Idempotent.
   */
  public stopHealthCheck(): void {
    if (this._healthCheckTimer !== null) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
  }

  /**
   * One health probe. A failed probe degrades the driver and attempts a single reconnect; it
   * never throws, because it runs on a timer with no caller to receive the error.
   */
  protected async runHealthCheck(): Promise<void> {
    this.publishPoolMetrics();

    let alive = false;

    try {
      alive = await this.ping();
    } catch {
      alive = false;
    }

    if (alive) {
      this.setState(ConnectionState.Connected);
      return;
    }

    this.setState(ConnectionState.Degraded);

    try {
      // The driver stays DEGRADED even when reconnecting succeeds: a fresh handle is not
      // evidence that queries work. Only the next successful probe promotes it back to
      // Connected — drivers whose own connect() verifies the link ( mysql takes and releases
      // a real connection ) set the state themselves.
      await this.connect();
    } catch (err) {
      this.Log.warn(`health check reconnect for ${this.Options.Name} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Point-in-time pool state. The base implementation reports an empty pool; drivers that own a
   * real pool override it. Must never throw — it runs on the health-check timer.
   */
  public poolMetrics(): IPoolMetrics {
    return { Size: 0, InUse: 0, Waiting: 0 };
  }

  /**
   * Pushes the current pool state and connection state to the shared `Metrics` registry from
   * `@spinajs/telemetry-common`. Nothing has to be wired for this to work — `Metrics` owns a
   * private registry and `@spinajs/telemetry`'s `/metrics` endpoint renders that same singleton.
   */
  public publishPoolMetrics(): void {
    try {
      const metrics = ormMetrics();

      if (!metrics) {
        return;
      }

      const labels = { connection: this.Options.Name };
      const pool = this.poolMetrics();

      ormGauge(metrics, ORM_METRIC_KEY_POOL_SIZE).set(labels, pool.Size);
      ormGauge(metrics, ORM_METRIC_KEY_POOL_IN_USE).set(labels, pool.InUse);
      ormGauge(metrics, ORM_METRIC_KEY_POOL_WAITING).set(labels, pool.Waiting);
      ormGauge(metrics, ORM_METRIC_KEY_CONNECTION_STATE).set(labels, this.State === ConnectionState.Connected ? 1 : 0);
    } catch (err) {
      // Telemetry must never break a connection. This runs first on every health tick, so a
      // registry that throws — or a driver built outside DI, as tooling and tests do — would
      // otherwise stop the probe that follows it from ever running.
      this.Log?.trace(`publishing pool metrics for ${this.Options.Name} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Records one pool-acquire wait, in SECONDS ( prometheus convention ). Drivers that own a real
   * pool call this from the acquire callback; keeping the prom-client objects behind this method
   * is what stops every driver from needing to know about `@spinajs/telemetry-common`. Never
   * throws, for the same reason `publishPoolMetrics` never throws.
   */
  public observeAcquireSeconds(seconds: number): void {
    try {
      const metrics = ormMetrics();

      if (!metrics) {
        return;
      }

      ormHistogram(metrics, ORM_METRIC_KEY_ACQUIRE_SECONDS).observe({ connection: this.Options.Name }, seconds);
    } catch (err) {
      this.Log?.trace(`observing pool acquire time for ${this.Options.Name} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Creates select query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public select<T>(): SelectQueryBuilder<T> {
    return this.Container.resolve(SelectQueryBuilder, [this]) as SelectQueryBuilder<T>;
  }

  /**
   * Creates delete query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public del<T>(): DeleteQueryBuilder<T> {
    return this.Container.resolve(DeleteQueryBuilder, [this]) as DeleteQueryBuilder<T>;
  }

  /**
   * Creates insert query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public insert(): InsertQueryBuilder {
    return this.Container.resolve(InsertQueryBuilder, [this]);
  }

  /**
   * Truncates given table
   */
  public truncate(table: string): TruncateTableQueryBuilder {
    const b = this.Container.resolve(TruncateTableQueryBuilder, [this]);
    b.setTable(table);
    return b;
  }

  /**
   * Creates update query builder associated with this connection.
   * This can be used to execute raw queries to db without orm model layer
   */
  public update<T>(): UpdateQueryBuilder<T> {
    return this.Container.resolve(UpdateQueryBuilder, [this]);
  }

  /**
   * Creates schema query builder associated with this connection.
   * This can be use to modify database structure
   */
  public schema(): SchemaQueryBuilder {
    return this.Container.resolve(SchemaQueryBuilder, [this]);
  }

  /**
   * Creates index query builder associated with this connection.
   * This can be use to create table indexes
   */
  public index(): IndexQueryBuilder {
    return this.Container.resolve(IndexQueryBuilder, [this]);
  }

  /**
   * Opens a transaction and returns its per-transaction context. Drivers that pool connections
   * acquire one here and put it on the context; drivers with a single shared handle return a
   * context without a connection.
   */
  protected abstract _begin(options?: ITransactionOptions): Promise<ITransactionContext>;

  /**
   * Commits the transaction described by `ctx`.
   */
  protected abstract _commit(ctx: ITransactionContext): Promise<void>;

  /**
   * Rolls the transaction described by `ctx` back.
   */
  protected abstract _rollback(ctx: ITransactionContext): Promise<void>;

  /**
   * Takes a named savepoint inside the transaction described by `ctx`.
   */
  protected abstract _savepoint(ctx: ITransactionContext, name: string): Promise<void>;

  /**
   * Releases a named savepoint — the nested block succeeded and its changes fold into the
   * enclosing transaction.
   */
  protected abstract _releaseSavepoint(ctx: ITransactionContext, name: string): Promise<void>;

  /**
   * Discards everything done since a named savepoint, leaving the enclosing transaction intact.
   */
  protected abstract _rollbackToSavepoint(ctx: ITransactionContext, name: string): Promise<void>;

  /**
   * Releases whatever `_begin` acquired. Called exactly once per transaction, on every exit
   * path. A no-op for drivers that acquire nothing.
   */
  protected abstract _dispose(ctx: ITransactionContext): Promise<void>;

  /**
   * Runs `cb` inside a transaction and owns its whole lifecycle: commits when the callback
   * resolves, rolls back when it throws, and releases the connection exactly once either way.
   * Resolves with whatever the callback returned.
   *
   * Statements issued inside the callback run on this transaction's connection automatically —
   * the context is carried through `AsyncLocalStorage`, so nothing has to be threaded through
   * by hand.
   *
   * Calling it again while a transaction is already in scope on this async path does **not**
   * open a second, independent transaction: it takes a savepoint, so a failing nested block
   * rolls back only its own work.
   *
   * @param cb - the transaction body
   * @param options - optional isolation level, validated against {@link SupportedIsolationLevels}
   */
  public async transaction<R>(cb: TransactionCallback<R>, options?: ITransactionOptions): Promise<R> {
    if (options?.isolation && !this.SupportedIsolationLevels.includes(options.isolation)) {
      throw new OrmException(`isolation level ${options.isolation} not supported by driver ${this.Options.Driver}`);
    }

    const active = this.TransactionStorage.getStore();

    // already inside a transaction — nest with a savepoint rather than opening a second one
    if (active) {
      const name = `sp_${++active.depth}`;

      await this._savepoint(active, name);

      try {
        const result = await cb(this);
        await this._releaseSavepoint(active, name);
        return result;
      } catch (err) {
        await this._rollbackToSavepoint(active, name);
        throw err;
      }
    }

    const ctx = await this._begin(options);
    ctx.depth = 0;

    try {
      const result = await this.TransactionStorage.run(ctx, () => cb(this));
      await this._commit(ctx);
      return result;
    } catch (err) {
      // swallow a rollback failure so it cannot mask whatever actually went wrong
      await this._rollback(ctx).catch(() => undefined);
      throw err;
    } finally {
      await this._dispose(ctx);
    }
  }
}
