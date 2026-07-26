import { Log } from '@spinajs/log-common';
/* eslint-disable prettier/prettier */
import { IColumnDescriptor, IDriverOptions, IPoolOptions, ISupportedFeature, IsolationLevel, ITransactionContext, ITransactionOptions, ModelToSqlConverter, ObjectToSqlConverter } from './interfaces.js';
import { SyncService, IContainer, DI, Container, Autoinject } from '@spinajs/di';
import { UpdateQueryBuilder, SelectQueryBuilder, IndexQueryBuilder, DeleteQueryBuilder, InsertQueryBuilder, SchemaQueryBuilder, TruncateTableQueryBuilder, Builder } from './builders.js';
import { JsonValueConverter, StandardModelToSqlConverter, StandardObjectToSqlConverter, UniversalValueConverter, UuidConverter } from './converters.js';
import { OrmException } from './exceptions.js';
import { AsyncLocalStorage } from 'async_hooks';
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
