import { Container, Inject, NewInstance, DI } from '@spinajs/di';
import type { Constructor, IContainer } from '@spinajs/di';
import { ORM_MODEL_FACTORY } from '../tokens.js';
import { InvalidArgument, MethodNotImplemented } from '@spinajs/exceptions';
import type { QueryMethod } from '../enums.js';
import { QueryContext, QueryMiddleware } from '../interfaces.js';
import type { ICompilerOutput, IQueryBuilder, IBuilderMiddleware, IBuilder } from '../interfaces.js';
import type { OrmDriver } from '../driver.js';
import type { ModelBase } from '../model.js';
import { isNullOrWhitespace } from '@spinajs/util';
import { executeRecorded } from '../schema-touches.js';
import type { SchemaTouch } from '../schema-touches.js';
import type { BuilderState } from '../extensions.js';

/** Stable: Array.prototype.sort keeps the DI order of equal keys. A non-finite order counts as 0. */
function sortQueryMiddlewares(list: QueryMiddleware[]): QueryMiddleware[] {
  const key = (m: QueryMiddleware) => (Number.isFinite(m.order) ? m.order : 0);
  return [...list].sort((a, b) => key(a) - key(b));
}

@NewInstance()
@Inject(Container)
export class Builder<T = any> implements IBuilder<T> {
  protected _driver: OrmDriver;
  protected _container: IContainer;
  protected _model?: Constructor<ModelBase>;

  protected _nonSelect: boolean;
  protected _middlewares: IBuilderMiddleware<T>[] = [];
  protected _queryMiddlewares: QueryMiddleware[] = [];

  protected _asRaw: boolean;

  public QueryContext: QueryContext;

  public get Driver(): OrmDriver {
    return this._driver;
  }

  public get Container(): IContainer {
    return this._container;
  }

  public get Model(): Constructor<ModelBase> | undefined {
    return this._model;
  }

  constructor(container: IContainer, driver: OrmDriver, model?: Constructor<ModelBase>) {
    this._driver = driver;
    this._container = container;
    this._model = model;
    this._nonSelect = true;
    this._asRaw = false;

    this._queryMiddlewares = sortQueryMiddlewares(DI.resolve(Array.ofType(QueryMiddleware)));
  }

  /**
   * Memoized result of {@link execute}. A builder executes at most once; awaiting
   * it again resolves with the same value instead of re-running the query.
   * Call `clone()` first if you genuinely need a second round-trip.
   */
  protected _executionPromise: Promise<T> | null = null;

  /** Before hooks, the driver call and after hooks: the part `_run()` may put in a transaction. */
  private async _executeWithQueryMiddlewares(): Promise<T> {
    const query = this as unknown as QueryBuilder;

    // Fires for EVERY builder type, not just SELECT. This used to live on
    // `SelectQueryBuilder._run`, so an INSERT/UPDATE/DELETE never reached a
    // `beforeQueryExecution` hook at all — which silently disabled any middleware that
    // needs the finished query (rbac's insert-ownership check is exactly that: the payload
    // does not exist until `values()` has been called, long after construction).
    //
    // Awaited in sequence, not `forEach`ed: a hook that needs a database round-trip to
    // decide — an rbac rule whose ownership lives in another table — could otherwise only
    // return a promise into the void, and the query would execute anyway. For a security
    // check that is the difference between enforcing and pretending to.
    for (const middleware of this._queryMiddlewares) {
      await middleware.beforeQueryExecution(query);
    }

    const result = await executeRecorded(this._driver, () => this.schemaTouches(), () => this._executeOnDriver());

    for (const middleware of this._queryMiddlewares) {
      await middleware.afterQueryExecution?.(query, result);
    }

    return result;
  }

  /** The tables this statement changes; the migration runner re-reads the table info of their models only. */
  protected schemaTouches(): SchemaTouch {
    return this.QueryContext === QueryContext.Schema ? 'all' : [];
  }

  /** The driver round trip of one execution; a builder that needs several statements overrides it. */
  protected _executeOnDriver(): Promise<T> {
    return this._driver.execute(this) as Promise<T>;
  }

  /**
   * The execution engine. Sends the compiled query to the driver, applies the
   * result middlewares, hydrates models and awaits the post-hydration middlewares.
   *
   * Always *returns* its value — the caller's promise chain is what propagates it.
   * Subclasses override this (not `execute()`) so that their extra work also lands
   * inside the memo.
   */
  protected async _run(): Promise<T> {
    const wrap = this._driver.CurrentTransaction === undefined && this._queryMiddlewares.some((m) => m.transactional?.(this as unknown as QueryBuilder) === true);
    const result = wrap ? await this._driver.transaction(() => this._executeWithQueryMiddlewares()) : await this._executeWithQueryMiddlewares();

    return this._materialize(result);
  }

  /** Result middlewares, hydration and post-hydration middlewares over one driver result. `stream()` runs it once per batch. */
  protected async _materialize(result: T): Promise<T> {
    // Snapshot the pipeline once, *after* the driver call: compiling the query is what
    // registers the relation middlewares (the driver calls `toDB()`), so this is the first
    // point at which the list is complete. Everything below runs against this immutable copy,
    // so a middleware registered later cannot change the pipeline mid-flight, and — crucially —
    // we never call `Array.prototype.reverse()` on `this._middlewares`, which mutates in place
    // and used to flip `modelCreation` resolution order on every execution ( B8 ).
    const middlewares = [...this._middlewares];
    const creationOrder = [...middlewares].reverse();

    if (this._asRaw) {
      return result;
    }

    const transformedResult = result;

    // if we have something to transform ...
    if (transformedResult) {
      middlewares.forEach((m) => {
        Object.assign(transformedResult, m.afterQuery(transformedResult));
      });
    }

    if (this._model && !this._nonSelect) {
      // TODO: rething this casting
      const models = (transformedResult as unknown as any[]).map((r) => {
        let model = null;
        for (const middleware of creationOrder) {
          model = middleware.modelCreation(r);
          if (model !== null) {
            break;
          }
        }

        if (model === null) {
          model = DI.resolve(ORM_MODEL_FACTORY, [this._model]);
        }

        model.hydrate(r);

        // This is the one point at which the instance's columns hold exactly what the
        // database returned, so it is the diff baseline for `save()`. Relation members
        // are attached later by the afterHydration middlewares below, which record their
        // own member keys into this same snapshot.
        model.takeSnapshot();

        // Nested relation data that arrived on the row itself ( belongsTo LEFT JOIN,
        // and hasMany arrays passed straight to hydrate ) was attached by the hydrators
        // inside `hydrate()` above — i.e. before the snapshot existed, so their own
        // `snapshotRelation` calls no-opped. Record those relations now.
        for (const name of (model.ModelDescriptor?.Relations ?? new Map()).keys()) {
          if ((model as any)[name]?.Populated) {
            model.snapshotRelation(name);
          }
        }

        return model;
      });

      if (middlewares.length > 0) {
        await Promise.all(middlewares.map((m) => m.afterHydration(models)));
      }

      return models as unknown as T;
    }

    return transformedResult;
  }

  /**
   * Executes the query. The single entry point for execution — `then()` delegates here.
   * The underlying work runs exactly once per builder instance; subsequent calls resolve
   * with the memoized result.
   */
  public execute(): Promise<T> {
    if (!this._executionPromise) {
      this._executionPromise = this._run();
    }

    return this._executionPromise;
  }

  then<TResult1 = T, TResult2 = never>(onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  public catch<TResult = never>(onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null): Promise<T | TResult> {
    return this.execute().catch(onrejected);
  }

  public finally(onfinally?: (() => void) | null): Promise<T> {
    return this.execute().finally(onfinally);
  }

  public middleware(middleware: IBuilderMiddleware<T>) {
    this._middlewares.push(middleware);
    return this;
  }

  /**
   * Builds query that is ready to use in DB
   */
  public toDB(): ICompilerOutput | ICompilerOutput[] {
    throw new MethodNotImplemented();
  }
}

/**
 * Base class for queires. Implements basic query functionality
 *
 */
@NewInstance()
@Inject(Container)
export class QueryBuilder<T = any> extends Builder<T> implements IQueryBuilder {
  protected _method!: QueryMethod;
  protected _table!: string;
  protected _tableAlias!: string;
  protected _database!: string;

  constructor(container: IContainer, driver: OrmDriver, model?: Constructor<ModelBase>) {
    super(container, driver, model);
  }

  /**
   * SQL table name that query is executed on
   *
   * @example
   * SELECT * FROM `users`
   */
  public get Table() {
    return this._table;
  }

  /**
   * DB table alias
   */
  public get TableAlias() {
    return this._tableAlias;
  }

  /**
   * SQL schema/database name that query is executed on.
   *
   * @example
   * SELECT * FROM `spinejs`.`users` as u
   */
  public get Database() {
    return this._database;
  }

  /**
   * Sets schema to this query.
   *
   * @param database - schema or database name in database
   */
  public database(database: string) {
    this._database = database;
    return this;
  }

  /**
   * Sets table that query is executed on
   *
   * @param table - sql table name
   * @param alias - sql table alias
   *
   * @example
   *
   * this.setTable("user","u")
   *
   */
  public setTable(table: string, alias?: string) {
    if (isNullOrWhitespace(table)) {
      throw new InvalidArgument('table name is empty');
    }

    this._table = table;
    if (alias !== undefined) {
      this.setAlias(alias);
    }

    return this;
  }

  /**
   * Sets table alias for query
   *
   * @param alias - sql table alias
   */
  public setAlias(alias: string) {
    this._tableAlias = alias;

    return this;
  }

  public from(table: string, alias?: string): this {
    return this.setTable(table, alias);
  }

  /** What a query extension method may read from the builder. */
  public state(): Readonly<BuilderState> {
    return { model: this._model, relations: [], container: this._container, owner: undefined, connection: this._driver };
  }
}
