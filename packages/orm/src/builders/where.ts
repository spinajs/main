import { NewInstance } from '@spinajs/di';
import type { Container, Constructor } from '@spinajs/di';
import { InvalidArgument, InvalidOperation } from '@spinajs/exceptions';
import { OrmException } from '../exceptions.js';
import _ from 'lodash';
import { WhereBoolean, SqlOperator } from '../enums.js';
import type { Op } from '../enums.js';
import type { IWhereBuilder, ISelectQueryBuilder, IRelationDescriptor } from '../interfaces.js';
import { BetweenStatement, ExistsQueryStatement, InQueryStatement, InSetStatement, InStatement, StartsWithStatement, RawQueryStatement, WhereQueryStatement, WhereStatement, Wrap, LazyQueryStatement, ColumnCompareStatement } from '../statements.js';
import type { ConcatExpression, IQueryStatement, OuterColumn } from '../statements.js';
import type { ModelDataWithRelationDataSearchable, PickRelations, Unbox, WhereFunction } from '../types.js';
import type { ModelBase } from '../model.js';
import { Lazy } from '@spinajs/util';
import { ExistsRelationHandler } from '../existsRelationHandlers.js';
import { RawQuery } from './raw.js';
import type { QueryBuilder } from './base.js';
import type { SelectQueryBuilder } from './select.js';
import { isSelectQuery } from './internal.js';

function isWhereOperator(val: any) {
  return _.isString(val) && Object.values(SqlOperator).includes((val as any).toLowerCase());
}

@NewInstance()
export class WhereBuilder<T> implements IWhereBuilder<T> {
  protected _statements: IQueryStatement[] = [];

  protected _boolean: WhereBoolean = WhereBoolean.AND;

  protected _container: Container;

  protected _model: Constructor<ModelBase>;

  protected _parent: WhereBuilder<T>;

  protected _tableAlias: string;

  public get TableAlias(): string {
    return this._tableAlias ?? (this._parent ? this._parent.TableAlias : undefined);
  }

  public get Model() {
    return this._model;
  }

  public get Container() {
    return this._container;
  }

  get Statements() {
    return this._statements;
  }



  get Op() {
    return this._boolean;
  }

  constructor(parent: WhereBuilder<T>) {
    this._container = parent.Container;
    this._boolean = WhereBoolean.AND;
    this._statements = [];
    this._model = parent.Model;
    this._parent = parent;
    this._tableAlias = parent.TableAlias;
  }

  public clone<P extends IWhereBuilder<any>>(_parent: P): WhereBuilder<T> {
    // TODO: fix this cast
    const builder = new WhereBuilder<T>(_parent as any);

    // Model and alias are restored BEFORE the statements are cloned, not after: a cloned
    // statement rebinds to `builder` and re-validates its column against `builder.Model`
    // ( see WhereStatement's constructor ). A nested where-builder may carry a different
    // model than the parent it is being re-attached to, and cloning it while `builder`
    // still held the parent's model made the clone throw "column X not exists in model Y".
    builder._boolean = this._boolean;
    builder._model = this._model;
    builder._tableAlias = this.TableAlias;

    builder._statements = this._statements.map((s) => {
      const cloned = s.clone(builder);
      // preserve the per-statement boolean connector (clone() rebuilds the
      // statement from scratch and would otherwise reset it to the AND default)
      cloned.Boolean = s.Boolean;
      return cloned;
    });

    return builder;
  }

  /**
   * The builder this one is nested in, or `undefined` for a top level builder.
   *
   * Exposed so a statement that owns a nested where-builder can re-attach a clone of it to
   * the same parent when it is cloned without being handed one.
   */
  public get Parent(): IWhereBuilder<T> | undefined {
    return this._parent;
  }

  /** Whether this builder compiles to any condition: a group with nothing in it compiles to none and is dropped. */
  public hasCondition(): boolean {
    return this._statements.some((s) => !WhereQueryStatement.isGroup(s) || s.Builder.hasCondition());
  }


  /**
   * Pushes a statement onto this builder, stamping it with the currently pending
   * boolean connector (set by {@link orWhere}/{@link andWhere}). The pending
   * connector applies to the NEXT pushed statement only and resets to AND
   * afterwards, so `where(a).where(b).orWhere(c).where(d)` compiles to
   * `a AND b OR c AND d` rather than rewriting the whole clause.
   */
  protected pushStatement(statement: IQueryStatement): this {
    statement.Boolean = this._boolean;
    this._statements.push(statement);
    this._boolean = WhereBoolean.AND;
    return this;
  }

  public when(condition: boolean, callback?: WhereFunction<T>, callbackElse?: WhereFunction<T>): this {
    if (condition) {
      if (callback) callback.call(this);
    } else if (callbackElse) {
      callbackElse.call(this);
    }
    return this;
  }

  public where(column: string | boolean | WhereFunction<T> | Lazy<void> | RawQuery | Wrap | Partial<ModelDataWithRelationDataSearchable<Unbox<T>>> | PickRelations<T>, operator?: SqlOperator | any, value?: any): this {
    const self = this;

    if (_.isString(column)) {
      /**
       * Special case for nested relations search
       * We use populate for relation, so if we search by relation it will be fetched
       * and filled to model.
       */
      if (column.indexOf('.') !== -1) {
        (self as any as SelectQueryBuilder).populate(column.slice(0, column.lastIndexOf('.')), function () {
          this.where(column.slice(column.lastIndexOf('.') + 1), operator, value);
        });
        return this;
      }

      /**
       * special case if we just search by relation
       * then use foreign key
       */
      if (this._model) {
        const desc = (this._model as any).getModelDescriptor();
        const rel = desc.Relations.get(column);
        if (rel) {
          return this.where(rel.ForeignKey, operator, value);
        }
      }
    }

    if (column === null || (column === undefined && arguments.length === 1)) {
      return this;
    }

    // TRUE and FALSE are no T-SQL; a comparison of two constants is valid in every dialect.
    if (_.isBoolean(column)) {
      return this.where(RawQuery.create(column ? '1 = 1' : '1 = 0'));
    }

    if (column instanceof RawQuery) {
      this.pushStatement(this._container.resolve<RawQueryStatement>(RawQueryStatement, [column.Query, column.Bindings, self.TableAlias]));
      return this;
    }

    // handle nested where's
    if (_.isFunction(column)) {
      const builder = new WhereBuilder(this);
      column.call(builder);

      self.pushStatement(this._container.resolve<WhereQueryStatement>(WhereQueryStatement, [builder, false]));
      return this;
    }

    if (column instanceof Lazy) {
      this.pushStatement(this._container.resolve<LazyQueryStatement>(LazyQueryStatement, [column, this]));
      return this;
    }

    // handle simple key = object[key] AND ....
    if (_.isObject(column) && !(column instanceof Wrap)) {
      return this.whereObject(column);
    }

    if (typeof value === 'undefined') {
      return _handleForTwo(column, operator);
    }

    return _handleForThree(column, operator, value);

    /**
     * handles for where("foo", 1).where(...) cases
     * it produces WHERE foo = 1
     */
    function _handleForTwo(c: any, v: any) {
      const sVal = v;

      if (sVal === undefined) {
        throw new InvalidArgument(`value cannot be undefined`);
      }

      if (Number.isNaN(sVal)) {
        throw new InvalidArgument(`value cannot be NaN`);
      }

      if (!_.isString(c) && !(c instanceof Wrap)) {
        throw new InvalidArgument(`column is not of type string or wrapped.`);
      }

      if (sVal === null) {
        return self.whereNull(c);
      }

      self.pushStatement(self._container.resolve<WhereStatement>(WhereStatement, [c, SqlOperator.EQ, sVal, self]));

      return self;
    }

    /**
     * Handles for where("foo",'!=',1) etc
     * it produces WHERE foo != 1
     */
    function _handleForThree(c: any, o: any, v: any) {
      const sVal = v;

      if (!isWhereOperator(o)) {
        throw new InvalidArgument(`operator ${o} is invalid`);
      }

      if (!_.isString(c) && !(c instanceof Wrap)) {
        throw new InvalidArgument(`column is not of type string or wrapped.`);
      }

      if (Number.isNaN(sVal)) {
        throw new InvalidArgument(`value cannot be NaN`);
      }

      if (sVal === null) {
        const op = String(o).toLowerCase();
        // where(col, '=', null) => IS NULL ; where(col, '!=' / '<>', null) => IS NOT NULL
        if (op === SqlOperator.EQ) {
          return self.whereNull(c);
        }
        if (op === SqlOperator.NOT || op === SqlOperator.NOT_2) {
          return self.whereNotNull(c);
        }
        throw new InvalidArgument(`operator ${o} cannot be used with null value ( only =, !=, <> are allowed )`);
      }

      self.pushStatement(self._container.resolve<WhereStatement>(WhereStatement, [c, o, sVal, self]));

      return self;
    }
  }

  public orWhere(column: string | boolean | WhereFunction<T> | Lazy<void> | RawQuery | Wrap | Partial<ModelDataWithRelationDataSearchable<Unbox<T>>>, ..._args: any[]) {
    this._boolean = WhereBoolean.OR;
    return this.where(column, ...Array.from(arguments).slice(1));
  }

  public andWhere(column: string | boolean | WhereFunction<T> | Lazy<void> | RawQuery | Wrap | Partial<ModelDataWithRelationDataSearchable<Unbox<T>>>, ..._args: any[]) {
    this._boolean = WhereBoolean.AND;
    return this.where(column, ...Array.from(arguments).slice(1));
  }

  public whereObject(obj: any) {
    this._boolean = WhereBoolean.AND;

    for (const key of Object.keys(obj).filter((x) => obj[x] !== undefined)) {
      const val = obj[key];
      if (Array.isArray(val)) {
        // empty array => SQL `IN ()` semantics => match nothing (FALSE),
        // never "no condition" (which would match everything)
        this.whereIn(key, val);
      } else if (val === null) {
        this.whereNull(key);
      } else this.andWhere(key, SqlOperator.EQ, val);
    }

    return this;
  }

  public whereNotNull(column: string | Wrap): this {
    this.pushStatement(this._container.resolve<WhereStatement>(WhereStatement, [column, SqlOperator.NOT_NULL, null, this]));

    return this;
  }

  public whereNull(column: string | Wrap): this {
    this.pushStatement(this._container.resolve<WhereStatement>(WhereStatement, [column, SqlOperator.NULL, null, this]));
    return this;
  }

  public whereNot(column: string | WhereFunction<T>, val?: any): this {
    if (_.isFunction(column)) {
      const builder = new WhereBuilder(this);
      column.call(builder);
      return this.pushStatement(this._container.resolve<WhereQueryStatement>(WhereQueryStatement, [builder, true]));
    }

    return this.where(column, SqlOperator.NOT, val);
  }

  public whereIn(column: string | Wrap, val: any[] | ISelectQueryBuilder): this {
    if (isSelectQuery(val)) {
      if (column instanceof Wrap) {
        throw new InvalidArgument('whereIn(): a wrapped column takes a list of values, not a sub-query');
      }
      this.correlateSubQuery(val, 'whereIn');
      this.pushStatement(this._container.resolve<InQueryStatement>(InQueryStatement, [val, column, false, this]));
      return this;
    }

    if (!Array.isArray(val)) {
      throw new InvalidArgument(`whereIn value must be an array or a sub-query builder, got ${typeof val}`);
    }

    // `IN ()` matches nothing in SQL; compile an empty set to FALSE rather than
    // emitting no condition (which would silently match every row).
    if (val.length === 0) {
      this.where(false);
      return this;
    }
    this.pushStatement(this._container.resolve<InStatement>(InStatement, [column, val, false, this]));
    return this;
  }

  public whereNotIn(column: string | Wrap, val: any[] | ISelectQueryBuilder): this {
    if (isSelectQuery(val)) {
      if (column instanceof Wrap) {
        throw new InvalidArgument('whereNotIn(): a wrapped column takes a list of values, not a sub-query');
      }
      this.correlateSubQuery(val, 'whereNotIn');
      this.pushStatement(this._container.resolve<InQueryStatement>(InQueryStatement, [val, column, true, this]));
      return this;
    }

    if (!Array.isArray(val)) {
      throw new InvalidArgument(`whereNotIn value must be an array or a sub-query builder, got ${typeof val}`);
    }

    this.pushStatement(this._container.resolve<InStatement>(InStatement, [column, val, true, this]));
    return this;
  }

  public whereExist<R>(query: ISelectQueryBuilder | string, callback?: WhereFunction<R>): this {
    return this.buildExistsClause(query, false, callback);
  }

  public whereNotExists<R>(query: ISelectQueryBuilder | string, callback?: WhereFunction<R>): this {
    return this.buildExistsClause(query, true, callback);
  }

  /**
   * Shared implementation for {@link whereExist} / {@link whereNotExists}.
   *
   * For a ready sub-query it pushes an {@link ExistsQueryStatement} directly. For a relation
   * name it resolves the matching {@link ExistsRelationHandler} from the container (one per
   * {@link RelationType}) and lets it either mutate this builder or return a correlated
   * sub-query that we then wrap in EXISTS / NOT EXISTS.
   *
   * @param query relation name or a ready sub-query
   * @param negated `true` for NOT EXISTS, `false` for EXISTS
   * @param callback optional where-callback applied to the relation sub-query
   */
  protected buildExistsClause<R>(query: ISelectQueryBuilder | string, negated: boolean, callback?: WhereFunction<R>): this {
    if (typeof query !== 'string') {
      this.correlateSubQuery(query, negated ? 'whereNotExists' : 'whereExist');
      this.pushStatement(this._container.resolve<ExistsQueryStatement>(ExistsQueryStatement, [query, negated]));
      return this;
    }

    const rel = (this._model as any).getRelationDescriptor(query) as IRelationDescriptor;
    if (!rel) {
      throw new OrmException(`relation ${query} not found in model ${this.constructor.name}`);
    }

    const handlers = this._container.resolve(Array.ofType(ExistsRelationHandler));
    const handler = handlers.find((h) => h.Type === rel.Type);
    if (!handler) {
      throw new OrmException(`no ExistsRelationHandler registered for relation type ${rel.Type} (relation ${query} on ${this.constructor.name})`);
    }

    const subquery = handler.apply(this, rel, query, callback);
    if (subquery) {
      this.pushStatement(this._container.resolve<ExistsQueryStatement>(ExistsQueryStatement, [subquery, negated]));
    }

    return this;
  }

  /**
   * outer() in the sub-query names this builder; a clone re-correlates the same way. A sub-query
   * already correlated with another query would keep answering for that one, so it is refused.
   */
  protected correlateSubQuery(query: ISelectQueryBuilder, method: string): void {
    const source = query.CorrelationSource;
    if (source === undefined) {
      query.correlateWith(this as IWhereBuilder<any>);
    } else if (queryOf(source) !== queryOf(this as IWhereBuilder<any>)) {
      throw new InvalidArgument(`${method}(): the sub-query is already correlated with another query; attach a clone() of it`);
    }
  }

  public whereBetween(column: string, val: any[]): this {
    this.pushStatement(this._container.resolve<BetweenStatement>(BetweenStatement, [column, val, false, this.TableAlias]));
    return this;
  }

  public whereNotBetween(column: string, val: any[]): this {
    this.pushStatement(this._container.resolve<BetweenStatement>(BetweenStatement, [column, val, true, this.TableAlias]));
    return this;
  }

  // conditions added in callback are join-scoped: emitted in relation JOIN ON clause
  // instead of parent WHERE when populated; on a root query act as normal WHERE
  public whereOnJoin(callback: WhereFunction<T>): this {
    const start = this._statements.length;
    callback.call(this);
    for (let i = start; i < this._statements.length; i++) {
      this._statements[i].OnJoin = true;
    }
    return this;
  }

  public whereInSet(column: string, val: any[]): this {
    this.pushStatement(this._container.resolve<InSetStatement>(InSetStatement, [column, val, false, this.TableAlias]));
    return this;
  }

  public whereNotInSet(column: string, val: any[]): this {
    this.pushStatement(this._container.resolve<InSetStatement>(InSetStatement, [column, val, true, this.TableAlias]));
    return this;
  }

  public whereColumn(left: string | Wrap, operator: Op, right: string | Wrap | OuterColumn | ConcatExpression): this {
    if (!isWhereOperator(operator)) {
      throw new InvalidArgument(`operator ${operator} is invalid`);
    }

    return this.pushStatement(this._container.resolve<ColumnCompareStatement>(ColumnCompareStatement, [left, operator, right, this]));
  }

  public whereStartsWith(column: string, prefix: string): this {
    this.pushStatement(this._container.resolve<StartsWithStatement>(StartsWithStatement, [column, prefix, this.TableAlias]));
    return this;
  }

  public clearWhere() {
    this._statements = [];
    return this;
  }
}

/** The query a where-builder belongs to: the parents of a nested group end at it. */
export function queryOf(builder: IWhereBuilder<any>): QueryBuilder {
  let current: unknown = builder;
  while (current instanceof WhereBuilder && current.Parent !== undefined) {
    current = current.Parent;
  }

  return current as QueryBuilder;
}

/**
 * What a column of `builder` is qualified with: its query's alias, else the table. Read from the query, not
 * the nested group, which copies the alias when it is created and misses a later `setAlias()`.
 */
export function qualifierOf(builder: IWhereBuilder<any>): string {
  const query = queryOf(builder);
  return query.TableAlias || query.Table;
}

/** The builder that `outer(column, levels)` names, seen from a statement of `builder`. */
export function outerBuilder(builder: IWhereBuilder<any>, levels: number): IWhereBuilder<any> {
  let target = builder;
  for (let level = 1; level <= levels; level++) {
    const source = (queryOf(target) as unknown as { CorrelationSource?: IWhereBuilder<any> }).CorrelationSource;
    if (!source) {
      throw new InvalidOperation(`outer(): the query is not a sub-query ${level} level(s) deep; attach it with whereExist() or whereIn()`);
    }
    target = source;
  }

  return target;
}
