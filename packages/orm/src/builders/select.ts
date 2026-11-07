import { Injectable, isConstructor } from '@spinajs/di';
import type { Constructor, IContainer } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { use } from 'typescript-mix';
import { ColumnMethods, QueryMethod, WhereBoolean, SqlOperator, SortOrder } from '../enums.js';
import { SelectQueryCompiler, QueryContext, RelationType, BooleanValueConverter } from '../interfaces.js';
import type { IKeysetPageOptions, IModelDescriptor, IStreamOptions, KeysetPage, RowLockMode, ICompilerOutput, ILimitBuilder, IQueryLimit, ISort, IWhereBuilder, IJoinBuilder, IBuilderMiddleware, IWithRecursiveBuilder, ITypedColumnsBuilder } from '../interfaces.js';
import { ColumnMethodStatement, WhereStatement, ColumnRawStatement, ColumnConditionStatement } from '../statements.js';
import type { ColumnStatement, IQueryStatement } from '../statements.js';
import type { Unbox, WhereFunction } from '../types.js';
import type { AggregateValue, ColumnName, ColumnRef, Head, MinMaxValue, OrmStrict, PopulateName, PopulatePath, PopulateTree, Project, Rebox, RelationTarget, Reproject, ScopesOf, WithPopulated } from '../typing.js';
import type { OrmDriver } from '../driver.js';
import type { ModelBase } from '../model.js';
import type { IOrmRelation } from '../relations.js';
import { relationOf } from '../relation-registry.js';
import { isNullOrWhitespace } from '@spinajs/util';
import { extractModelDescriptor } from '../descriptor.js';
import { StreamNotSupported } from '../exceptions.js';
import { applyKeysetPredicate, assertKeysetNotNull, decodeCursor, keysetColumns, keysetOfSorts, keysetPage, keysetValues } from '../keyset.js';
import { hasPk } from '../primary-keys.js';
import { executeRecorded } from '../schema-touches.js';
import type { IRelationSort } from './internal.js';
import { executionCopy, runCloneHooks } from './internal.js';
import type { BuilderState } from '../extensions.js';
import { QueryBuilder } from './base.js';
import { LimitBuilder } from './limit.js';
import { OrderByBuilder } from './order-by.js';
import { ColumnsBuilder } from './columns.js';
import { GroupByBuilder } from './group-by.js';
import { JoinBuilder } from './join.js';
import { WithRecursiveBuilder } from './with-recursive.js';
import { WhereBuilder } from './where.js';

/** A select builder whose row type changed; the model's query scopes stay on it. */
export type SelectNarrowed<B, T, R> = SelectQueryBuilder<Rebox<T, R>> & ScopesOf<B>;
/** Class counterpart of StrictAliasNarrowed, so a class-typed chain keeps the class (mergeRelations, mergeStatements, ...). */
export type StrictSelectAliasNarrowed<B, T, A extends string, R> = OrmStrict extends true ? (string extends A ? B : SelectNarrowed<B, T, R>) : B;

export interface SelectQueryBuilder<T> extends ITypedColumnsBuilder<T>, ILimitBuilder<T>, IWhereBuilder<T>, IJoinBuilder, IWithRecursiveBuilder { }

const DEFAULT_STREAM_BATCH = 500;

/** Reads the driver's value of a selectCondition() column as a boolean. */
class BooleanColumnMiddleware implements IBuilderMiddleware<any> {
  constructor(
    private readonly alias: string,
    private readonly converter: BooleanValueConverter,
  ) {}

  public afterQuery(data: any): any {
    if (Array.isArray(data)) {
      for (const row of data as unknown[]) {
        if (row !== null && typeof row === 'object' && this.alias in row) {
          const record = row as Record<string, unknown>;
          record[this.alias] = this.converter.fromDB(record[this.alias], row, null);
        }
      }
    }

    return data;
  }

  public modelCreation(): ModelBase | null {
    return null;
  }

  public async afterHydration(): Promise<void> {}
}

@Injectable(SelectQueryBuilder)
export class SelectQueryBuilder<T = any> extends QueryBuilder<T> {
  /**
   * column query props
   */
  protected _distinct: boolean;
  protected _rowLock: RowLockMode | undefined;
  protected _columns: IQueryStatement[] = [];

  /**
   * limit query props
   */
  protected _fail: boolean;
  protected _first: boolean;
  protected _limit: IQueryLimit;

  /**
   * order by query props
   */
  protected _sorts: ISort[];
  protected _orderable: string[];

  /**
   * where query props
   */
  protected _statements: IQueryStatement[] = [];

  protected _boolean: WhereBoolean;

  protected _joinStatements: IQueryStatement[] = [];

  protected _groupStatements: IQueryStatement[] = [];

  protected _cteStatement: IQueryStatement | undefined;

  protected _relations: IOrmRelation[] = [];

  protected _owner: IOrmRelation | undefined;

  /**
   * The outer builder this query is correlated to, set when this query is the sub-select of a
   * correlated EXISTS ( see {@link ExistsRelationHandler} ).
   *
   * The correlation predicate — `<outer alias or table>.<key> = <this query>.<key>` — cannot be
   * frozen into a string when the sub-query is built, because the outer alias is often assigned
   * afterwards ( `populate()` calls `setAlias()` ). It is therefore emitted from a lazy
   * statement that reads the outer alias at COMPILE time, and this field is the link it reads
   * it through.
   *
   * It is a field rather than a closure variable precisely so that `clone()` can REBIND it: a
   * cloned query must correlate against ITSELF, not against the query it was cloned from. A
   * closure could not be rebound, and the clone silently kept pointing at the original — see
   * `ExistsQueryStatement.clone()`.
   */
  protected _correlationSource: IWhereBuilder<any> | undefined;

  public get Statements() {
    return this._statements;
  }

  /**
   * The outer builder this query is correlated to, or `undefined` when it is not a correlated
   * sub-query.
   */
  public get CorrelationSource(): IWhereBuilder<any> | undefined {
    return this._correlationSource;
  }

  /**
   * Marks this query as the correlated sub-select of `builder`.
   *
   * Called both when the sub-query is first built and every time the OWNING query is cloned,
   * so the clone's sub-query correlates to the clone.
   */
  public correlateWith(builder: IWhereBuilder<any> | undefined): this {
    this._correlationSource = builder;
    return this;
  }

  public get Owner(): IOrmRelation | undefined {
    return this._owner;
  }

  // The live relation list, not a copy: an extension that creates a relation (intl-orm's translate) pushes it here.
  public state(): Readonly<BuilderState> {
    return { ...super.state(), relations: this._relations, owner: this._owner };
  }

  @use(WhereBuilder, LimitBuilder, OrderByBuilder, ColumnsBuilder, JoinBuilder, WithRecursiveBuilder, GroupByBuilder)
  this!: this;

  public get IsDistinct() {
    return this._distinct;
  }

  public get RowLock(): RowLockMode | undefined {
    return this._rowLock;
  }

  public forUpdate(): this {
    this._rowLock = 'update';
    return this;
  }

  public forShare(): this {
    this._rowLock = 'share';
    return this;
  }

  public get Relations(): IOrmRelation[] {
    return this._relations;
  }

  /**
   * `applyMiddlewares` is false ONLY for {@link clone}. A clone is not a new query: every
   * statement, column, join and relation it ends up with is copied from the source builder,
   * which already went through `afterQueryCreation`. Running the middlewares again here
   * produced their constraints twice — once on the clone (immediately overwritten by the
   * copy below) and once carried over from the source — so a custom rbac hook fired twice per
   * clone, and any side effect it has ( a lookup, a counter, a registered relation ) happened
   * twice while its query effect was silently discarded.
   *
   * This is not a rare path: `SqlLazyQueryStatement.build()` clones the builder at COMPILE
   * time to evaluate a deferred `Lazy` callback in isolation, so every query carrying a
   * `Lazy` where-statement hit it on every compile.
   */
  constructor(container: IContainer, driver: OrmDriver, model?: Constructor<any>, owner?: IOrmRelation, applyMiddlewares = true) {
    super(container, driver, model);

    this._owner = owner;
    this._distinct = false;
    this._method = QueryMethod.SELECT;

    this._boolean = WhereBoolean.AND;

    this._sorts = [];
    this._orderable = [];

    this._first = false;
    this._limit = {
      limit: -1,
      offset: -1,
    };

    this._nonSelect = false;
    this.QueryContext = QueryContext.Select;

    if (applyMiddlewares) {
      this._queryMiddlewares.forEach((x) => x.afterQueryCreation(this));
    }
  }

  public async asRaw<T>(): Promise<T> {
    this._asRaw = true;
    return (await this) as any;
  }

  public setAlias(alias?: string) {

    // isNullOrWhitespace is not a type predicate; a false result guarantees a non-blank string
    const resolvedAlias: string = isNullOrWhitespace(alias) ? `${this._driver.Options.AliasSeparator}${this._table}${this._driver.Options.AliasSeparator}` : (alias as string);

    this._tableAlias = resolvedAlias;

    this._columns.forEach((c) => (c.TableAlias = resolvedAlias));
    this._joinStatements.forEach((c) => (c.TableAlias = resolvedAlias));
    this._statements.forEach((c) => (c.TableAlias = resolvedAlias));

    return this;
  }

  public clone(): this {
    // Middlewares are deliberately NOT run for the clone — see the constructor's note.
    const builder = new SelectQueryBuilder<T>(this._container, this._driver, this._model, this._owner, false);

    // Table, alias and correlation are restored BEFORE the statements are cloned. Statements
    // rebind to `builder` and several of them read these during their own clone.
    builder._table = this._table;
    builder._tableAlias = this._tableAlias;
    builder._correlationSource = this._correlationSource;

    // Clone columns
    builder._columns = this._columns.map(c => c.clone(builder));

    // Clone joinStatements with mapped WhereBuilder references
    builder._joinStatements = this._joinStatements.map(c => c.clone(builder));

    // Clone statements with mapped WhereBuilder references
    builder._statements = this._statements.map(c => c.clone(builder));

    // Clone group-by statements (previously dropped, silently losing GROUP BY
    // on a cloned query).
    builder._groupStatements = this._groupStatements.map(c => c.clone(builder));

    // Carry relations and result middlewares over. These hold live objects and
    // are shared the same way mergeRelations()/mergeBuilder() already share them.
    builder._relations = [...this._relations];
    builder._middlewares = [...this._middlewares];

    /**
     * ------------------------------------------------------------------
     */

    builder._limit = { ...this._limit };
    builder._sorts = this._sorts.map((s) => ({ ...s }));
    builder._orderable = [...this._orderable];
    builder._boolean = this._boolean;
    builder._distinct = this._distinct;
    builder._rowLock = this._rowLock;
    builder._cteStatement = this._cteStatement ? this._cteStatement.clone(builder) : undefined;
    builder._first = this._first;
    builder._nonSelect = this._nonSelect;
    builder._queryMiddlewares = [...this._queryMiddlewares];
    builder._database = this._database;

    runCloneHooks(this, builder);

    return builder as any;
  }

  protected _getRelationInstance(relation: string) {

    // TODO: do not use toLocaleLowerCase for comparison, relations should be case sensitive
    // leave it now for backward compatibility
    let relInstance: IOrmRelation | undefined = this._relations.find((r) => r.Name.toLocaleLowerCase() === relation.toLocaleLowerCase());

    if (!relInstance) {
      const descriptor = extractModelDescriptor(this._model);
      let rDescriptor = null;
      for (const [key, value] of descriptor!.Relations) {

        // TODO: do not use toLocaleLowerCase for comparison, relations should be case sensitive
        // leave it now for backward compatibility
        if (key.toLowerCase() === relation.toLowerCase().trim()) {
          rDescriptor = value;
          break;
        }
      }

      if (!rDescriptor) {
        throw new InvalidArgument(`Relation ${relation} not exists in model ${this._model?.constructor.name}`);
      }

      if (rDescriptor.Recursive) {
        relInstance = this._container.resolve<IOrmRelation>(relationOf('recursive'), [this, rDescriptor, this._owner]);
      } else {
        switch (rDescriptor.Type) {
          case RelationType.One:
            // if parent relation is one to many we dont set parent relation
            // couse its new query to not mess with column aliases and hydrator
            relInstance = this._container.resolve<IOrmRelation>(relationOf(RelationType.One), [this, rDescriptor, this._owner instanceof relationOf(RelationType.Many) ? null : this._owner]);
            break;
          case RelationType.Query:
          case RelationType.Virtual:
          case RelationType.Many:
            relInstance = this._container.resolve<IOrmRelation>(relationOf(rDescriptor.Type), [this, rDescriptor, this._owner]);
            break;
          case RelationType.ManyToMany:
            relInstance = this._container.resolve<IOrmRelation>(relationOf(RelationType.ManyToMany), [this, rDescriptor, null]);
            break;
        }
      }
      if (relInstance) {
        this._relations.push(relInstance);
      }
    }

    return relInstance;
  }

  // A nullish relation is a no-op, so routes with an optional `include` param
  // can pass it straight through.
  public populate<P extends PopulatePath<Unbox<T>>>(relation: P, callback?: (this: SelectQueryBuilder<RelationTarget<Unbox<T>, Head<P>>[]>, relation: IOrmRelation) => void): SelectNarrowed<this, T, WithPopulated<Unbox<T>, P>>;
  public populate<_R = this>(relation: Constructor<ModelBase>): this;
  public populate<R = this>(relation?: PopulateName<Unbox<T>> | PopulateName<Unbox<T>>[] | null, callback?: (this: SelectQueryBuilder<R>, relation: IOrmRelation) => void): this;
  public populate<R = this>(relation: PopulateTree<Unbox<T>>, callback?: (this: SelectQueryBuilder<R>, relation: IOrmRelation) => void): this;
  public populate(relation?: string | string[] | Constructor<ModelBase> | {} | null, callback?: (this: any, relation: IOrmRelation) => void): any {

    if (!relation) {
      return this;
    }

    if (isConstructor(relation)) {
      const descriptor = extractModelDescriptor(this._model);
      const relations = descriptor!.Relations;
      const rel = relations.values().find((r) => r.TargetModel === (relation as Constructor<ModelBase>));

      if (!rel) {
        throw new InvalidArgument(`Cannot find relation for model ${(relation as Constructor<ModelBase>).name} in model ${this._model ? this._model.name : 'undefined'}`);
      }

      return this.populate(rel.Name, callback);
    }

    if (Array.isArray(relation)) {
      relation.forEach((x) => this.populate(x, callback));
      return this;
    }

    if (typeof relation === 'object') {
      for (const i in (relation as any)) {
        this.populate(i, () => {
          // TODO: remove cast, linter thinks relation is null ???
          if (typeof (relation as any)[i] !== null) this.populate((relation as any)[i]);
        });
      }

      return this;
    }

    // if relation is in path format eg. posts.comments.user
    // we populate root relation and then call populate on next nested relation
    if (typeof relation === 'string' && relation.includes('.')) {
      const r = relation.slice(0, relation.indexOf('.'));
      this.populate(r, function () {
        this.populate(relation.slice(relation.indexOf('.') + 1), callback);
      });

      return this;
    }

    // Everything that is not a string was handled above (constructor / array /
    // object), so the remaining value is a plain relation name.
    this._getRelationInstance(relation as string).execute(callback);

    return this;
  }

  public mergeBuilder(builder: SelectQueryBuilder, includeStatements = true) {
    this._columns = this._columns.concat(builder._columns);
    this._cteStatement = builder._cteStatement;
    this._distinct = builder._distinct;
    // Fold the merged builder's sorts into this query's sorts (multi-column
    // ORDER BY). If the merged builder has no sorts, this keeps our own.
    // Stamped with the merged builder's alias: a belongsTo relation rides in the parent FROM as a
    // LEFT JOIN, so its bare column name would resolve against the parent table ( or be ambiguous ).
    // A sort answering a `Relation.column` slot of ours replaces that slot, the rest is appended.
    builder.validateSorts();
    const merged: IRelationSort[] = builder._sorts.map((s) => ({ ...s, tableAlias: s.tableAlias ?? builder._tableAlias }));
    const slots = new Set((this._sorts as IRelationSort[]).map((s) => s.awaits).filter(Boolean));
    this._sorts = (this._sorts as IRelationSort[])
      .flatMap((s) => {
        const answers = s.awaits ? merged.filter((m) => m.fills === s.awaits) : [];
        return answers.length ? answers.map((m) => ({ ...m, fills: s.fills })) : [s];
      })
      .concat(merged.filter((m) => !m.fills || !slots.has(m.fills)));
    // `includeStatements: false` is used by JoinStatement so that a join
    // callback's WHERE conditions are NOT folded into the main query's WHERE
    // (which silently turns a LEFT JOIN into an inner filter). The join emits
    // those conditions in its own ON clause instead. Columns/sort are still
    // merged so join-callback selects (e.g. extra joined columns) keep working.
    if (includeStatements) {
      this.mergeStatements(builder);
    }
  }

  public mergeRelations(builder: SelectQueryBuilder) {
    this._relations = this._relations.concat(builder._relations);
    this._middlewares = this._middlewares.concat(builder._middlewares);
  }

  public mergeStatements(builder: SelectQueryBuilder, callback?: (statement: IQueryStatement) => boolean) {
    const stms = callback ? builder._statements.filter(callback) : builder._statements;
    this._joinStatements = this._joinStatements.concat(builder._joinStatements);
    this._statements = this._statements.concat(stms);
  }

  /**
   * Includes soft-deleted rows in the result set by removing the default
   * `DeletedAt IS NULL` filter added by createQuery for @SoftDelete models.
   */
  public withDeleted(): this {
    const descriptor = extractModelDescriptor(this._model);
    const deletedAt = descriptor?.SoftDelete?.DeletedAt;

    if (!deletedAt) {
      return this;
    }

    this._statements = this._statements.filter((s) => {
      return !(s instanceof WhereStatement && s.Column === deletedAt && s.Operator === SqlOperator.NULL);
    });

    return this;
  }

  /**
   * Includes archived rows in the result set by removing the default `ArchivedAt IS NULL`
   * filter added by createQuery for @Archived models. Mirror of {@link withDeleted}.
   */
  public withArchived(): this {
    const descriptor = extractModelDescriptor(this._model);
    const archivedAt = descriptor?.Archived?.ArchivedAt;

    if (!archivedAt) {
      return this;
    }

    this._statements = this._statements.filter((s) => {
      return !(s instanceof WhereStatement && s.Column === archivedAt && s.Operator === SqlOperator.NULL);
    });

    return this;
  }

  public min<C extends ColumnName<Unbox<T>>, A extends string>(column: C, as: A): StrictSelectAliasNarrowed<this, T, A, Project<Unbox<T>, Record<A, MinMaxValue<Unbox<T>, C> | null>>>;
  public min(column: ColumnRef<Unbox<T>>, as?: string): this;
  public min(column: string, as?: string): this {
    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [column, ColumnMethods.MIN, as, this._tableAlias]));
    return this;
  }

  public max<C extends ColumnName<Unbox<T>>, A extends string>(column: C, as: A): StrictSelectAliasNarrowed<this, T, A, Project<Unbox<T>, Record<A, MinMaxValue<Unbox<T>, C> | null>>>;
  public max(column: ColumnRef<Unbox<T>>, as?: string): this;
  public max(column: string, as?: string): this {
    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [column, ColumnMethods.MAX, as, this._tableAlias]));
    return this;
  }

  public count<A extends string = 'count'>(column?: ColumnRef<Unbox<T>>, as?: A): StrictSelectAliasNarrowed<this, T, A, Reproject<Unbox<T>, Record<A, AggregateValue>>>;
  public count(column?: string, as?: string) {
    const c = column ?? '*';
    const a = as ?? 'count';

    this.clearColumns();

    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [c, ColumnMethods.COUNT, a, this._tableAlias]));

    return this;
  }

  public selectCount(column?: ColumnRef<Unbox<T>>, as?: string): Promise<number>;
  public selectCount(column?: string, as?: string) {
    const a = as ?? 'count';

    // postgres returns COUNT(*) as a bigint string
    return this.count(column, as).takeFirst()
      .asRaw<{ [key: string]: number | string }>()
      .then((x) => Number(x?.[a] ?? 0));
  }

  public sum<A extends string>(column: ColumnRef<Unbox<T>>, as: A): StrictSelectAliasNarrowed<this, T, A, Project<Unbox<T>, Record<A, AggregateValue | null>>>;
  public sum(column: ColumnRef<Unbox<T>>, as?: string): this;
  public sum(column: string, as?: string): this {
    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [column, ColumnMethods.SUM, as, this._tableAlias]));
    return this;
  }

  public avg<A extends string>(column: ColumnRef<Unbox<T>>, as: A): StrictSelectAliasNarrowed<this, T, A, Project<Unbox<T>, Record<A, AggregateValue | null>>>;
  public avg(column: ColumnRef<Unbox<T>>, as?: string): this;
  public avg(column: string, as?: string): this {
    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [column, ColumnMethods.AVG, as, this._tableAlias]));
    return this;
  }

  /**
   * Selects `condition` as the column `alias`. Rows read through the builder hold a boolean on every
   * driver (its BooleanValueConverter); `asRaw()` keeps the driver's 1 / 0.
   */
  public selectCondition(alias: string, condition: WhereFunction<T>): this {
    const builder = new WhereBuilder<T>(this as unknown as WhereBuilder<T>);
    condition.call(builder);
    this._columns.push(this._container.resolve<ColumnConditionStatement>(ColumnConditionStatement, [builder, alias]));
    this.middleware(new BooleanColumnMiddleware(alias, this._container.resolve<BooleanValueConverter>(BooleanValueConverter)));
    return this;
  }

  public distinct() {
    if (this._columns.length === 0 || (this._columns[0] as ColumnStatement).IsWildcard) {
      throw new InvalidOperation('Cannot force DISTINCT on unknown column');
    }

    this._distinct = true;
    return this;
  }

  public toDB(): ICompilerOutput {
    this.validateSorts();
    const compiler = this._container.resolve<SelectQueryCompiler>(SelectQueryCompiler, [this]);
    return compiler.compile();
  }

  /**
   * A sort column usually arrives from a request. Unchecked it reaches the database as an
   * unknown identifier and comes back as a driver error instead of a bad argument.
   * Select aliases stay sortable, and a raw select opts the query out - its aliases are not visible here.
   */
  public validateSorts() {
    const columns = extractModelDescriptor(this._model)?.Columns ?? [];
    const declared = this.getOrderable();
    // A raw select yields identifiers this cannot see, so a query holding one is left alone -
    // unless it declared them itself through `orderable()`, which puts it back under the check.
    if (columns.length === 0 || (declared.length === 0 && this._columns.some((c) => c instanceof ColumnRawStatement))) {
      return;
    }

    const aliases = [...this._columns.map((c) => (c as ColumnStatement).Alias).filter(Boolean), ...declared];
    for (const sort of this.getSorts()) {
      if (sort.tableAlias || aliases.includes(sort.column)) {
        continue;
      }

      if (!columns.some((c) => c.Name === sort.column && !c.Virtual)) {
        throw new InvalidArgument(`Cannot order by ${sort.column}, column does not exist on model ${this._model?.name}`);
      }
    }
  }

  public async all(): Promise<T> {
    return await this.execute();
  }

  public async resultExists(): Promise<boolean> {
    const res = await this.execute();

    if (Array.isArray(res)) {
      return res.length > 0;
    }

    return res !== undefined && res !== null;
  }

  public stream(options: IStreamOptions = {}): AsyncIterable<Unbox<T>> {
    const batchSize = options.batchSize ?? DEFAULT_STREAM_BATCH;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new InvalidArgument(`batchSize must be a positive integer, got ${String(batchSize)}`);
    }

    return this._streamRows(batchSize) as AsyncIterable<Unbox<T>>;
  }

  protected async *_streamRows(batchSize: number): AsyncGenerator<unknown> {
    if (this._first) {
      throw new InvalidOperation('stream() cannot follow first() or takeFirst()');
    }

    if (!this._wantsTransaction() && (await this._driver.canStreamNatively())) {
      yield* this._streamFromCursor(batchSize);
      return;
    }

    // a page is a whole statement through executeOnDb: it leaves the connection free between pages and carries the
    // session settings, which a cursor outside a transaction cannot
    yield* this._streamByKeyset(batchSize);
  }

  /** Same test as `Builder._run`: a query middleware (authz-orm's row filter) that needs a transaction gets one per page. */
  private _wantsTransaction(): boolean {
    return this._queryMiddlewares.some((m) => m.transactional?.(this) === true);
  }

  protected async *_streamFromCursor(batchSize: number): AsyncGenerator<unknown> {
    for (const middleware of this._queryMiddlewares) {
      await middleware.beforeQueryExecution(this);
    }

    // recorded like `_run`, so the migration tool's dry run sees the tables a stream reads
    const rows = await executeRecorded(this._driver, () => this.schemaTouches(), () => Promise.resolve(this._driver.executeStream(this, { batchSize })));
    let batch: unknown[] = [];

    for await (const row of rows) {
      batch.push(row);
      if (batch.length === batchSize) {
        yield* await this._streamBatch(batch);
        batch = [];
      }
    }

    if (batch.length !== 0) {
      yield* await this._streamBatch(batch);
    }
  }

  private async _streamBatch(rows: unknown[]): Promise<unknown[]> {
    for (const middleware of this._queryMiddlewares) {
      await middleware.afterQueryExecution?.(this, rows);
    }

    return (await this._materialize(rows as unknown as T)) as unknown as unknown[];
  }

  /** Each page is an execution copy of this query, run the normal way, past the last row of the page before. */
  protected async *_streamByKeyset(batchSize: number): AsyncGenerator<unknown> {
    const descriptor = extractModelDescriptor(this._model);
    // compiles the relations, which merges a populated relation's order into this one, and fills every copy's middlewares
    this.toDB();
    const sorts = this.getSorts();
    this._assertKeysetPageable(sorts, descriptor);

    const columns = keysetColumns(keysetOfSorts(sorts), descriptor);
    assertKeysetNotNull(columns, descriptor);

    let last: unknown[] | undefined;
    for (;;) {
      const page = executionCopy(this);
      for (const tieBreaker of columns.slice(sorts.length)) {
        page.order(tieBreaker.column, SortOrder.ASC);
      }
      if (last) {
        applyKeysetPredicate(page, columns, last, 'after');
      }
      page.take(batchSize);

      const rows = (await page) as unknown as unknown[];
      yield* rows;

      if (rows.length < batchSize) {
        return;
      }
      last = keysetValues(columns, rows.at(-1));
    }
  }

  private _assertKeysetPageable(sorts: ISort[], descriptor: IModelDescriptor | null | undefined): asserts descriptor is IModelDescriptor {
    if (sorts.length === 0 || !descriptor || !hasPk(descriptor)) {
      throw new StreamNotSupported(`stream() pages by keyset here (driver ${String(this._driver.Options.Driver)} without a cursor, a transaction or session settings), which needs order() on a model with a primary key`);
    }

    const blocker = this._keysetBlocker();
    if (blocker) {
      throw new StreamNotSupported(`stream() pages by keyset here and cannot keep ${blocker}`);
    }
  }

  public async paginate(options: IKeysetPageOptions<Unbox<T>>): Promise<KeysetPage<Unbox<T>>> {
    this._assertPageable(options);

    const descriptor = extractModelDescriptor(this._model);
    const columns = keysetColumns(options.orderBy as ReadonlyArray<readonly [string, 'asc' | 'desc']>, descriptor ?? undefined);
    if (descriptor) {
      assertKeysetNotNull(columns, descriptor);
    }
    const backward = options.before !== undefined;
    const cursor = options.before ?? options.after;

    for (const { column, order } of columns) {
      this.order(column, (order === 'asc') !== backward ? SortOrder.ASC : SortOrder.DESC);
    }
    const blocker = this._keysetBlocker();
    if (blocker) {
      throw new InvalidOperation(`paginate() cannot keep ${blocker}`);
    }
    if (cursor !== undefined) {
      applyKeysetPredicate(this as unknown as IWhereBuilder<unknown>, columns, decodeCursor(columns, cursor), backward ? 'before' : 'after');
    }
    this.take(options.limit + 1);

    const rows = (await this.execute()) as unknown as Array<Unbox<T>>;
    return keysetPage(columns, rows, options.limit, { cursor, backward });
  }

  private _assertPageable(options: { limit: number; after?: string; before?: string }): void {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new InvalidArgument(`limit must be a positive integer, got ${String(options.limit)}`);
    }

    if (options.after !== undefined && options.before !== undefined) {
      throw new InvalidArgument('give either after or before, not both');
    }

    if (this.getSorts().length !== 0 || this._first) {
      throw new InvalidOperation('paginate() sets the order and the limit itself; remove order(), take(), skip() and first() from the query');
    }
  }

  /** Each page is a fresh LIMIT past the last row of the page before, so the rows must be the table's rows in order. */
  private _keysetBlocker(): string | undefined {
    const { limit = -1, offset = -1 } = this._limit;
    if (limit > 0 || offset > 0) {
      return 'take() or skip()';
    }
    if (this._distinct || this._groupStatements.length !== 0 || this._columns.some((c) => c instanceof ColumnMethodStatement)) {
      return 'distinct(), groupBy() or an aggregate column';
    }
    if ((this._sorts as IRelationSort[]).some((s) => s.tableAlias !== undefined || s.awaits !== undefined)) {
      return 'an order by a relation column';
    }
    return undefined;
  }

  /**
   * Overrides the engine rather than `execute()` so that the `takeFirst()` unwrapping
   * happens *inside* the memo. `beforeQueryExecution` is dispatched by `Builder._run()`
   * for every builder type, so it still fires once per builder rather than once per await.
   */
  protected async _run(): Promise<T> {
    const result = await super._run();

    if (this._first && Array.isArray(result)) {
      return (result.length !== 0 ? result[0] : undefined) as T;
    }

    return result;
  }
}

export class SelectQueryBuilderC<T = any> extends SelectQueryBuilder<T> { }
