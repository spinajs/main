/* eslint-disable prettier/prettier */
import { Container, Inject, NewInstance, Constructor, IContainer, DI, Injectable } from '@spinajs/di';
import { InvalidArgument, MethodNotImplemented, InvalidOperation } from '@spinajs/exceptions';
import { OrmException } from './exceptions.js';
import _ from 'lodash';
import { use } from 'typescript-mix';
import { ColumnMethods, ColumnType, QueryMethod, SortOrder, WhereBoolean, SqlOperator, JoinMethod } from './enums.js';
import { DeleteQueryCompiler, IColumnsBuilder, ICompilerOutput, ILimitBuilder, InsertQueryCompiler, IOrderByBuilder, IQueryBuilder, IQueryLimit, ISort, IWhereBuilder, SelectQueryCompiler, TruncateTableQueryCompiler, TableQueryCompiler, AlterTableQueryCompiler, UpdateQueryCompiler, QueryContext, IJoinBuilder, IndexQueryCompiler, RelationType, IBuilderMiddleware, IWithRecursiveBuilder, ReferentialAction, IGroupByBuilder, IUpdateResult, DefaultValueBuilder, ColumnAlterationType, TableExistsCompiler, DropTableCompiler, TableCloneQueryCompiler, QueryMiddleware, DropEventQueryCompiler, EventQueryCompiler, IBuilder, IDeleteQueryBuilder, IUpdateQueryBuilder, ISelectQueryBuilder } from './interfaces.js';
import { BetweenStatement, ColumnMethodStatement, ColumnStatement, ExistsQueryStatement, InSetStatement, InStatement, IQueryStatement, RawQueryStatement, WhereQueryStatement, WhereStatement, ColumnRawStatement, JoinStatement, WithRecursiveStatement, GroupByStatement, Wrap } from './statements.js';
import { ModelDataWithRelationDataSearchable, PickRelations, Unbox, WhereFunction } from './types.js';
import { OrmDriver } from './driver.js';
import { ModelBase, extractModelDescriptor } from './model.js';
import { OrmRelation, BelongsToRelation, IOrmRelation, OneToManyRelation, ManyToManyRelation, BelongsToRecursiveRelation } from './relations.js';
import { DateTime } from 'luxon';

/**
 *  Trick typescript by using the inbuilt interface inheritance and declaration merging
 *  for builder classes.
 *
 *  We use mixins to extend functionality of builder eg. insert query builder uses function from columns builder
 *  and so on...
 */
export interface InsertQueryBuilder extends IColumnsBuilder {}
export interface DeleteQueryBuilder<T> extends IDeleteQueryBuilder<T> {}
export interface UpdateQueryBuilder<T> extends IUpdateQueryBuilder<T> {}
export interface SelectQueryBuilder<T> extends IColumnsBuilder, IOrderByBuilder, ILimitBuilder<T>, IWhereBuilder<T>, IJoinBuilder, IWithRecursiveBuilder, IGroupByBuilder {}

function isWhereOperator(val: any) {
  return _.isString(val) && Object.values(SqlOperator).includes((val as any).toLowerCase());
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

    this._queryMiddlewares = DI.resolve(Array.ofType(QueryMiddleware));
  }

  then<TResult1 = T, TResult2 = never>(onfulfilled?: (value: T) => TResult1 | PromiseLike<TResult1>, onrejected?: (reason: any) => TResult2 | PromiseLike<TResult2>): PromiseLike<TResult1 | TResult2> {
    return this._driver
      .execute(this)
      .then((result: T) => {
        try {
          if (this._asRaw) {
            onfulfilled(result);
            return;
          }

          let transformedResult = result;

          // if we have something to transform ...
          if (transformedResult) {
            this._middlewares.forEach((m) => {
              Object.assign(transformedResult, m.afterQuery(transformedResult));
            });
          }

          if (this._model && !this._nonSelect) {
            // TODO: rething this casting
            const models = (transformedResult as unknown as any[]).map((r) => {
              let model = null;
              for (const middleware of this._middlewares.reverse()) {
                model = middleware.modelCreation(r);
                if (model !== null) {
                  break;
                }
              }

              if (model === null) {
                model = DI.resolve<ModelBase>('__orm_model_factory__', [this._model]);
              }

              model.hydrate(r);
              model.IsDirty = false;
              return model;
            });

            const afterMiddlewarePromises = this._middlewares.reduce((prev, current) => {
              return prev.concat([current.afterHydration(models)]);
            }, [] as Array<Promise<any[] | void>>);

            if (this._middlewares.length > 0) {
              Promise.all(afterMiddlewarePromises).then(() => {
                try {
                  onfulfilled(models as unknown as T);
                } catch (err) {
                  if (onrejected) {
                    onrejected(err);
                  } else {
                    throw err;
                  }
                }
              }, onrejected);
            } else {
              onfulfilled(models as unknown as T);
            }
          } else {
            onfulfilled(transformedResult);
          }
        } catch (err) {
          if (onrejected) {
            onrejected(err);
          } else {
            throw err;
          }
        }
      })
      .catch((err) => {
        if (onrejected) {
          onrejected(err);
        } else {
          throw err;
        }
      }) as Promise<any>;
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
  protected _method: QueryMethod;
  protected _table: string;
  protected _tableAlias: string;
  protected _database: string;

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
    if (!table.trim()) {
      throw new InvalidArgument('table name is empty');
    }

    this._table = table;
    this.setAlias(alias);

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
}

@NewInstance()
export class LimitBuilder<T> implements ILimitBuilder<T> {
  protected _first: boolean;
  protected _limit: IQueryLimit;

  constructor() {
    this._first = false;
    this._limit = {
      limit: -1,
      offset: -1,
    };
  }

  public take(count: number) {
    if (count <= 0) {
      throw new InvalidArgument(`take count cannot be negative number`);
    }

    this._limit.limit = count;
    return this;
  }

  public skip(count: number) {
    if (count < 0) {
      throw new InvalidArgument(`skip count cannot be negative number`);
    }

    this._limit.offset = count;
    return this;
  }

  public takeFirst() {
    this._first = true;
    this._limit.limit = 1;

    return this;
  }

  public async first() {
    return (await this.takeFirst()) as any;
  }

  public async firstOrFail() {
    return this.firstOrThrow(new OrmException('not found'));
  }

  public async orThrow(error: Error) {
    const result = (await this) as any;
    if (result === undefined || (Array.isArray(result) && result.length === 0)) {
      throw error;
    }

    return result;
  }

  public async firstOrThrow(error: Error) {
    const result = await this.first();
    if (result === undefined) {
      throw error;
    }

    return result;
  }

  public getLimits() {
    return this._limit;
  }
}

@NewInstance()
export class OrderByBuilder implements IOrderByBuilder {
  protected _sort: ISort;

  constructor() {
    this._sort = {
      column: '',
      order: SortOrder.ASC,
    };
  }

  public order(column: string, direction: SortOrder) {
    if (!column) {
      return this;
    }

    this._sort = {
      column,
      order: direction,
    };
    return this;
  }

  public orderBy(column: string) {
    this._sort = {
      column,
      order: SortOrder.ASC,
    };
    return this;
  }

  public orderByDescending(column: string) {
    this._sort = {
      column,
      order: SortOrder.DESC,
    };
    return this;
  }

  public getSort() {
    return this._sort.column.trim() !== '' ? this._sort : null;
  }
}

@NewInstance()
export class ColumnsBuilder implements IColumnsBuilder {
  protected _container: Container;
  protected _columns: IQueryStatement[];
  protected _tableAlias: string;
  protected _model?: Constructor<ModelBase>;

  constructor() {
    this._columns = [];
  }

  /**
   * Clears all select clauses from the query.
   *
   * @example
   *
   * query.columns()
   *
   */
  public clearColumns() {
    this._columns = [];

    return this;
  }

  public columns(names: string[]) {
    const descriptor = extractModelDescriptor(this._model);

    this._columns = names.map((n) => {
      return this._container.resolve<ColumnStatement>(ColumnStatement, [n, null, this._tableAlias, descriptor?.Columns.find((c) => c.Name === n)]);
    });

    return this;
  }

  public select(column: string | RawQuery | Map<string, string>, alias?: string) {
    const descriptor = extractModelDescriptor(this._model);

    if (column instanceof Map) {
      column.forEach((alias, colName) => {
        this._columns.push(this._container.resolve<ColumnStatement>(ColumnStatement, [colName, alias, this._tableAlias, descriptor?.Columns.find((c) => c.Name === colName)]));
      });
    }

    if (column instanceof RawQuery) {
      this._columns.push(this._container.resolve<ColumnRawStatement>(ColumnRawStatement, [column, null, this._tableAlias]));
    } else {
      this._columns.push(this._container.resolve<ColumnStatement>(ColumnStatement, [column, alias, this._tableAlias, descriptor?.Columns.find((c) => c.Name === column)]));
    }

    return this;
  }

  public getColumns() {
    return this._columns;
  }
}

@NewInstance()
export class RawQuery {
  get Query() {
    return this._query;
  }

  get Bindings() {
    return this._bindings;
  }

  public static create(query: string, bindings?: any[]) {
    return new RawQuery(query, bindings);
  }
  private _query = '';
  private _bindings: any[] = [];

  constructor(query: string, bindings?: any[]) {
    this._query = query;
    this._bindings = bindings;
  }
}
@NewInstance()
export class GroupByBuilder implements IGroupByBuilder {
  protected _container: Container;
  protected _groupStatements: IQueryStatement[] = [];

  public get GroupStatements(): IQueryStatement[] {
    return this._groupStatements;
  }

  public clearGroupBy(): this {
    this._groupStatements = [];
    return this;
  }

  public groupBy(expression: string | RawQuery): this {
    this._groupStatements.push(this._container.resolve<GroupByStatement>(GroupByStatement, [expression]));

    return this;
  }
}

@NewInstance()
export class JoinBuilder implements IJoinBuilder {
  protected _model?: Constructor<ModelBase>;

  public get JoinStatements() {
    return this._joinStatements;
  }

  protected _joinStatements: IQueryStatement[] = [];
  protected _container: Container;
  protected _tableAlias: string;

  constructor(container: Container) {
    this._container = container;
    this._joinStatements = [];
  }

  public clearJoins(): this {
    this._joinStatements = [];

    return this;
  }

  public innerJoin<R extends ModelBase>(model: R, where?: (this: SelectQueryBuilder<R>) => void): this;
  public innerJoin(query: RawQuery): this;
  public innerJoin(table: string, foreignKey: string, primaryKey: string, database?: string): this;
  public innerJoin<R extends ModelBase>(_table: string | RawQuery | R, _AliasOrForeignKey?: string | ((this: SelectQueryBuilder<R>) => void), _fkOrPkKey?: string, _primaryKey?: string): this {
    this.addJoinStatement.call(this, JoinMethod.INNER, ...arguments);
    return this;
  }

  public leftJoin<R extends ModelBase>(model: R, where?: (this: SelectQueryBuilder<R>) => void): this;
  public leftJoin(query: RawQuery): this;
  public leftJoin(table: string, foreignKey: string, primaryKey: string, database?: string): this;
  public leftJoin<R extends ModelBase>(_table: string | RawQuery | R, _AliasOrForeignKey?: string | ((this: SelectQueryBuilder<R>) => void), _fkOrPkKey?: string, _primaryKey?: string, _database?: string): this {
    this.addJoinStatement.call(this, JoinMethod.LEFT, ...arguments);
    return this;
  }

  public leftOuterJoin<R extends ModelBase>(model: R, where?: (this: SelectQueryBuilder<R>) => void): this;
  public leftOuterJoin(query: RawQuery): this;
  public leftOuterJoin(table: string, foreignKey: string, primaryKey: string, database?: string): this;
  public leftOuterJoin<R extends ModelBase>(_table: string | RawQuery | R, _AliasOrForeignKey?: string | ((this: SelectQueryBuilder<R>) => void), _fkOrPkKey?: string, _primaryKey?: string, _database?: string): this {
    this.addJoinStatement.call(this, JoinMethod.LEFT_OUTER, ...arguments);
    return this;
  }

  public rightJoin<R extends ModelBase>(model: R, where?: (this: SelectQueryBuilder<R>) => void): this;
  public rightJoin(query: RawQuery): this;
  public rightJoin(table: string, foreignKey: string, primaryKey: string, database?: string): this;
  public rightJoin<R extends ModelBase>(_table: string | RawQuery | R, _AliasOrForeignKey?: string | ((this: SelectQueryBuilder<R>) => void), _fkOrPkKey?: string, _primaryKey?: string, _database?: string): this {
    this.addJoinStatement.call(this, JoinMethod.RIGHT, ...arguments);
    return this;
  }

  public rightOuterJoin<R extends ModelBase>(model: R, where?: (this: SelectQueryBuilder<R>) => void): this;
  public rightOuterJoin(query: RawQuery): this;
  public rightOuterJoin(table: string, foreignKey: string, primaryKey: string, database?: string): this;
  public rightOuterJoin<R extends ModelBase>(_table: string | RawQuery | R, _AliasOrForeignKey?: string | ((this: SelectQueryBuilder<R>) => void), _fkOrPkKey?: string, _primaryKey?: string, _database?: string): this {
    this.addJoinStatement.call(this, JoinMethod.RIGHT_OUTER, ...arguments);
    return this;
  }

  public fullOuterJoin<R extends ModelBase>(model: R, where?: (this: SelectQueryBuilder<R>) => void): this;
  public fullOuterJoin(query: RawQuery): this;
  public fullOuterJoin(table: string, foreignKey: string, primaryKey: string, database?: string): this;
  public fullOuterJoin<R extends ModelBase>(_table: string | RawQuery | R, _AliasOrForeignKey?: string | ((this: SelectQueryBuilder<R>) => void), _fkOrPkKey?: string, _primaryKey?: string, _database?: string): this {
    this.addJoinStatement.call(this, JoinMethod.FULL_OUTER, ...arguments);
    return this;
  }

  public crossJoin<R extends ModelBase>(model: R, where?: (this: SelectQueryBuilder<R>) => void): this;
  public crossJoin(query: RawQuery): this;
  public crossJoin(table: string, foreignKey: string, primaryKey: string, database?: string): this;
  public crossJoin<R extends ModelBase>(_table: string | RawQuery | R, _AliasOrForeignKey?: string | ((this: SelectQueryBuilder<R>) => void), _fkOrPkKey?: string, _primaryKey?: string, _database?: string): this {
    this.addJoinStatement.call(this, JoinMethod.CROSS, ...arguments);
    return this;
  }

  private addJoinStatement(method: JoinMethod, table: string | RawQuery | ModelBase, AliasOrForeignKey?: string | ((this: SelectQueryBuilder<this>) => void), fkOrPkKey?: string, primaryKey?: string, _database?: string) {
    let stmt: JoinStatement = null;

    if (arguments.length === 3) {
      stmt = this._container.resolve<JoinStatement>(JoinStatement, [this, this._model, table, method, AliasOrForeignKey]);
    } else if (arguments.length === 4) {
      stmt = this._container.resolve<JoinStatement>(JoinStatement, [this, this._model, table, method, AliasOrForeignKey, fkOrPkKey, null, this._tableAlias]);
    } else if (arguments.length === 5) {
      stmt = this._container.resolve<JoinStatement>(JoinStatement, [this, this._model, table, method, fkOrPkKey, primaryKey, AliasOrForeignKey, this._tableAlias]);
    } else if (arguments.length === 6) {
      stmt = this._container.resolve<JoinStatement>(JoinStatement, [this, this._model, table, method, fkOrPkKey, primaryKey, AliasOrForeignKey, this._tableAlias, _database]);
    } else {
      stmt = this._container.resolve<JoinStatement>(JoinStatement, [this, this._model, table, method]);
    }

    this.JoinStatements.push(stmt);
  }
}

@NewInstance()
export class WithRecursiveBuilder implements IWithRecursiveBuilder {
  protected _container: Container;

  protected _cteStatement: IQueryStatement;

  public get CteRecursive() {
    return this._cteStatement;
  }

  public withRecursive(rcKeyName: string, pkName: string) {
    this._cteStatement = this._container.resolve<WithRecursiveStatement>(WithRecursiveStatement, ['cte', this, rcKeyName, pkName]);
    return this;
  }
}

@NewInstance()
export class WhereBuilder<T> implements IWhereBuilder<T> {
  protected _statements: IQueryStatement[] = [];

  protected _boolean: WhereBoolean = WhereBoolean.AND;

  protected _container: Container;
  protected _tableAlias: string;

  protected _model: Constructor<ModelBase>;

  get Statements() {
    return this._statements;
  }

  get Op() {
    return this._boolean;
  }

  constructor(container: Container, tableAlias?: string) {
    this._container = container;
    this._boolean = WhereBoolean.AND;
    this._statements = [];
    this._tableAlias = tableAlias;
  }

  public when(condition: boolean, callback?: WhereFunction<T>, callbackElse?: WhereFunction<T>): this {
    if (condition) {
      if (callback) callback.call(this);
    } else if (callbackElse) {
      callbackElse.call(this);
    }
    return this;
  }

  public where(column: string | boolean | WhereFunction<T> | RawQuery | Wrap | Partial<ModelDataWithRelationDataSearchable<Unbox<T>>> | PickRelations<T>, operator?: SqlOperator | any, value?: any): this {
    const self = this;

    if (column === null || (column === undefined && arguments.length === 1)) {
      return;
    }

    // Support "where true || where false"
    if (_.isBoolean(column)) {
      return this.where(RawQuery.create(column ? 'TRUE' : 'FALSE'));
    }

    if (column instanceof RawQuery) {
      this.Statements.push(this._container.resolve<RawQueryStatement>(RawQueryStatement, [column.Query, column.Bindings, self._tableAlias]));
      return this;
    }

    // handle nested where's
    if (_.isFunction(column)) {
      const builder = new WhereBuilder(this._container, this._tableAlias);
      column.call(builder);

      self.Statements.push(this._container.resolve<WhereQueryStatement>(WhereQueryStatement, [builder, self._tableAlias]));
      return this;
    }

    // handle simple key = object[key] AND ....
    if (_.isObject(column) && !(column instanceof Wrap)) {
      return this.whereObject(column);
    }

    if (typeof value === 'undefined') {
      return _handleForTwo.call(this, column, operator);
    }

    return _handleForThree.call(this, column, operator, value);

    /**
     * handles for where("foo", 1).where(...) cases
     * it produces WHERE foo = 1
     */
    function _handleForTwo(c: any, v: any) {
      let sVal = v;

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
        return this.whereNull(c);
      }

      self._statements.push(self._container.resolve<WhereStatement>(WhereStatement, [c, SqlOperator.EQ, sVal, self._tableAlias, this._container, self._model]));

      return self;
    }

    /**
     * Handles for where("foo",'!=',1) etc
     * it produces WHERE foo != 1
     */
    function _handleForThree(c: any, o: any, v: any) {
      let sVal = v;

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
        return this.whereNull(c);
      }

      if (sVal === null) {
        return o === SqlOperator.NOT_NULL ? this.whereNotNull(c) : this.whereNull(c);
      }

      self._statements.push(self._container.resolve<WhereStatement>(WhereStatement, [c, o, sVal, self._tableAlias, this._container, self._model]));

      return this;
    }
  }

  public orWhere(column: string | boolean | WhereFunction<T> | RawQuery | Wrap | Partial<ModelDataWithRelationDataSearchable<Unbox<T>>>, ..._args: any[]) {
    this._boolean = WhereBoolean.OR;
    return this.where(column, ...Array.from(arguments).slice(1));
  }

  public andWhere(column: string | boolean | WhereFunction<T> | RawQuery | Wrap | Partial<ModelDataWithRelationDataSearchable<Unbox<T>>>, ..._args: any[]) {
    this._boolean = WhereBoolean.AND;
    return this.where(column, ...Array.from(arguments).slice(1));
  }

  public whereObject(obj: any) {
    this._boolean = WhereBoolean.AND;

    for (const key of Object.keys(obj).filter((x) => obj[x] !== undefined)) {
      const val = obj[key];
      if (Array.isArray(val)) {
        if (val.length !== 0) {
          this.whereIn(key, val);
        }
      } else if (val === null) {
        this.whereNull(key);
      } else this.andWhere(key, SqlOperator.EQ, val);
    }

    return this;
  }

  public whereNotNull(column: string): this {
    this._statements.push(this._container.resolve<WhereStatement>(WhereStatement, [column, SqlOperator.NOT_NULL, null, this._tableAlias, this._container]));

    return this;
  }

  public whereNull(column: string): this {
    this._statements.push(this._container.resolve<WhereStatement>(WhereStatement, [column, SqlOperator.NULL, null, this._tableAlias, this._container]));
    return this;
  }

  public whereNot(column: string, val: any): this {
    return this.where(column, SqlOperator.NOT, val);
  }

  public whereIn(column: string, val: any[]): this {
    this._statements.push(this._container.resolve<InStatement>(InStatement, [column, val, false, this._tableAlias, this._container]));
    return this;
  }

  public whereNotIn(column: string, val: any[]): this {
    this._statements.push(this._container.resolve<InStatement>(InStatement, [column, val, true, this._tableAlias, this._container]));
    return this;
  }

  public whereExist<R>(query: ISelectQueryBuilder | string, callback?: WhereFunction<R>): this {
    // we must have alias or subquery could have conflicts on columns names
    if (!this._tableAlias) {
      this._tableAlias = '__exists__';
    }

    if (typeof query === 'string') {
      const rel = (this._model as any).getRelationDescriptor(query);
      if (!rel) {
        throw new OrmException(`relation ${query} not found in model ${this.constructor.name}`);
      }

      switch (rel.Type) {
        case RelationType.One:
          this.whereNotNull(rel.ForeignKey);

          // simply use right join for condition check
          if (callback) {
            // TODO: cast fix
            (this as any).rightJoin(rel.TargetModel, callback.bind(query));
          }

          break;
        case RelationType.Many:
          const relQuery = rel.TargetModel.query();
          const sourcePKey = `\`${this._tableAlias}\`.\`${(this._model as any).getModelDescriptor().PrimaryKey}\``;
          relQuery.where(new RawQuery(`${rel.ForeignKey} = ${sourcePKey}`));

          if (callback) {
            callback.apply(relQuery);
          }

          this.whereExist(relQuery);

          break;
        case RelationType.ManyToMany:
          throw new OrmException(`not implemented`);
      }
    } else {
      this._statements.push(this._container.resolve<ExistsQueryStatement>(ExistsQueryStatement, [query, false]));
    }

    return this;
  }

  public whereNotExists(query: SelectQueryBuilder): this {
    this._statements.push(this._container.resolve<ExistsQueryStatement>(ExistsQueryStatement, [query, true]));
    return this;
  }

  public whereBetween(column: string, val: any[]): this {
    this._statements.push(this._container.resolve<BetweenStatement>(BetweenStatement, [column, val, false, this._tableAlias]));
    return this;
  }

  public whereNotBetween(column: string, val: any[]): this {
    this._statements.push(this._container.resolve<BetweenStatement>(BetweenStatement, [column, val, true, this._tableAlias]));
    return this;
  }

  public whereInSet(column: string, val: any[]): this {
    this._statements.push(this._container.resolve<InSetStatement>(InSetStatement, [column, val, false, this._tableAlias]));
    return this;
  }

  public whereNotInSet(column: string, val: any[]): this {
    this._statements.push(this._container.resolve<InSetStatement>(InSetStatement, [column, val, true, this._tableAlias]));
    return this;
  }

  public clearWhere() {
    this._statements = [];
    return this;
  }
}
@Injectable(SelectQueryBuilder)
export class SelectQueryBuilder<T = any> extends QueryBuilder<T> {
  /**
   * column query props
   */
  protected _distinct: boolean;
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
  protected _sort: ISort;

  /**
   * where query props
   */
  protected _statements: IQueryStatement[] = [];

  protected _boolean: WhereBoolean;

  protected _joinStatements: IQueryStatement[] = [];

  protected _groupStatements: IQueryStatement[] = [];

  protected _cteStatement: IQueryStatement;

  protected _relations: IOrmRelation[] = [];

  protected _owner: IOrmRelation;

  public get Owner(): IOrmRelation {
    return this._owner;
  }

  @use(WhereBuilder, LimitBuilder, OrderByBuilder, ColumnsBuilder, JoinBuilder, WithRecursiveBuilder, GroupByBuilder)
  this: this;

  public get IsDistinct() {
    return this._distinct;
  }

  public get Relations(): IOrmRelation[] {
    return this._relations;
  }

  constructor(container: IContainer, driver: OrmDriver, model?: Constructor<any>, owner?: IOrmRelation) {
    super(container, driver, model);

    this._owner = owner;
    this._distinct = false;
    this._method = QueryMethod.SELECT;

    this._boolean = WhereBoolean.AND;

    this._sort = {
      column: '',
      order: SortOrder.ASC,
    };

    this._first = false;
    this._limit = {
      limit: -1,
      offset: -1,
    };

    this._nonSelect = false;
    this.QueryContext = QueryContext.Select;

    this._queryMiddlewares.forEach((x) => x.afterQueryCreation(this));
  }

  public async asRaw<T>(): Promise<T> {
    this._asRaw = true;
    return (await this) as any;
  }

  public setAlias(alias: string) {
    this._tableAlias = alias;

    this._columns.forEach((c) => (c.TableAlias = alias));
    this._joinStatements.forEach((c) => (c.TableAlias = alias));
    this._statements.forEach((c) => (c.TableAlias = alias));

    return this;
  }

  public clone(): this {
    const builder = new SelectQueryBuilder<T>(this._container, this._driver, this._model, this._owner);

    builder._columns = this._columns.slice(0);
    builder._joinStatements = this._joinStatements.slice(0);
    builder._statements = this._statements.slice(0);
    builder._limit = { ...this._limit };
    builder._sort = { ...this._sort };
    builder._boolean = this._boolean;
    builder._distinct = this._distinct;
    builder._table = this._table;
    builder._tableAlias = this._tableAlias;
    builder._queryMiddlewares = [...this._queryMiddlewares];

    return builder as any;
  }

  public populate<R = this>(relation: string[]): this;
  public populate<R = this>(relation: {}, callback?: (this: SelectQueryBuilder<R>, relation: IOrmRelation) => void): this;
  public populate<R = this>(relation: string | string[], callback?: (this: SelectQueryBuilder<R>, relation: IOrmRelation) => void): this {
    if (!relation) {
      return this;
    }

    if (Array.isArray(relation)) {
      relation.forEach((x) => this.populate(x, callback));
      return this;
    }

    if (typeof relation === 'object') {
      for (const i in relation) {
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
        this.populate(relation.slice(relation.indexOf('.') + 1));
      });

      return this;
    }

    // if relation was already populated, just call callback on it
    const fRelation = this._relations.find((r) => r.Name === relation);
    if (fRelation) {
      fRelation.executeOnQuery(callback);
      return this;
    }

    let relInstance: OrmRelation = null;
    const descriptor = extractModelDescriptor(this._model);

    let rDescriptor = null;

    for (const [key, value] of descriptor.Relations) {
      if (key.toLowerCase() === relation.toLowerCase().trim()) {
        rDescriptor = value;
        break;
      }
    }

    if (!rDescriptor) {
      throw new InvalidArgument(`Relation ${relation} not exists in model ${this._model?.constructor.name}`);
    }

    if (rDescriptor.Recursive) {
      relInstance = this._container.resolve<BelongsToRecursiveRelation>(BelongsToRecursiveRelation, [this, rDescriptor, this._owner]);
    } else {
      switch (rDescriptor.Type) {
        case RelationType.One:
          // if parent relation is one to many we dont set parent relation
          // couse its new query to not mess with column aliases and hydrator
          relInstance = this._container.resolve<BelongsToRelation>(BelongsToRelation, [this, rDescriptor, this._owner instanceof OneToManyRelation ? null : this._owner]);
          break;
        case RelationType.Many:
          relInstance = this._container.resolve<OneToManyRelation>(OneToManyRelation, [this, rDescriptor, this._owner]);
          break;
        case RelationType.ManyToMany:
          relInstance = this._container.resolve<ManyToManyRelation>(ManyToManyRelation, [this, rDescriptor, null]);
          break;
      }
    }

    relInstance.execute(callback);
    this._relations.push(relInstance);

    return this;
  }

  public mergeBuilder(builder: SelectQueryBuilder) {
    this._joinStatements = this._joinStatements.concat(builder._joinStatements);
    this._columns = this._columns.concat(builder._columns);
    this.mergeStatements(builder);
  }

  public mergeRelations(builder: SelectQueryBuilder) {
    this._relations = this._relations.concat(builder._relations);
    this._middlewares = this._middlewares.concat(builder._middlewares);
  }

  public mergeStatements(builder: SelectQueryBuilder, callback?: (statement: IQueryStatement) => boolean) {
    const stms = callback ? builder._statements.filter(callback) : builder._statements;
    this._statements = this._statements.concat(stms);
    this._limit = builder._limit;
    this._sort = builder._sort;
  }

  public min(column: string, as?: string): this {
    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [column, ColumnMethods.MIN, as, this._tableAlias]));
    return this;
  }

  public max(column: string, as?: string): this {
    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [column, ColumnMethods.MAX, as, this._tableAlias]));
    return this;
  }

  public count(column?: string, as?: string) {
    const c = column ?? '*';
    const a = as ?? 'count';

    this.clearColumns();

    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [c, ColumnMethods.COUNT, a, this._tableAlias]));
    return this.takeFirst().asRaw<{ [key: string]: number }>().then((x) => x[a]);
  }

  public sum(column: string, as?: string): this {
    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [column, ColumnMethods.SUM, as, this._tableAlias]));
    return this;
  }

  public avg(column: string, as?: string): this {
    this._columns.push(this._container.resolve<ColumnMethodStatement>(ColumnMethodStatement, [column, ColumnMethods.AVG, as, this._tableAlias]));
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
    const compiler = this._container.resolve<SelectQueryCompiler>(SelectQueryCompiler, [this]);
    return compiler.compile();
  }

  public async all(): Promise<T[]> {
    return (await this) as any;
  }

  public async resultExists(): Promise<boolean> {
    return this.then((res) => {
      if (Array.isArray(res)) {
        return res.length > 0;
      }

      return res !== undefined && res !== null;
    });
  }

  public then<TResult1 = T, TResult2 = never>(onfulfilled?: (value: T) => TResult1 | PromiseLike<TResult1>, onrejected?: (reason: any) => TResult2 | PromiseLike<TResult2>): PromiseLike<TResult1 | TResult2> {
    this._queryMiddlewares.forEach((x) => x.beforeQueryExecution(this));

    return super.then((result: T) => {
      if (this._first) {
        if (Array.isArray(result)) {
          if (result.length !== 0) {
            return onfulfilled(result ? result[0] : null);
          } else {
            try {
              return onfulfilled(undefined);
            } catch (err) {
              onrejected(err);
            }
          }
        } else {
          return onfulfilled(result);
        }
      } else {
        return onfulfilled(result);
      }
    }, onrejected);
  }

  public async execute(): Promise<T> {
    return (await this) as any;
  }
}

export class SelectQueryBuilderC<T = any> extends SelectQueryBuilder<T> {}

@NewInstance()
export class DeleteQueryBuilder<T> extends QueryBuilder<IUpdateResult> {
  /**
   * where query props
   */
  protected _statements: IQueryStatement[];
  protected _boolean: WhereBoolean;

  protected _limit: IQueryLimit;

  @use(WhereBuilder, LimitBuilder)
  /// @ts-ignore
  private this: this;

  constructor(container: Container, driver: OrmDriver, model: Constructor<any>) {
    super(container, driver, model);

    this._method = QueryMethod.DELETE;
    this._statements = [];
    this._boolean = WhereBoolean.AND;

    this._limit = {
      limit: -1,
      offset: -1,
    };

    this.QueryContext = QueryContext.Delete;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<DeleteQueryCompiler>(DeleteQueryCompiler, [this]).compile();
  }
}

@NewInstance()
export class OnDuplicateQueryBuilder {
  protected _column: string[];

  protected _parent: QueryBuilder;

  protected _columnsToUpdate: Array<string | RawQuery>;

  protected _container: IContainer;

  protected _returning: string[];

  constructor(container: IContainer, insertQueryBuilder: QueryBuilder, column?: string | string[], returning?: string[]) {
    this._parent = insertQueryBuilder;
    this._container = container;

    this._column = _.isArray(column) ? column : [column];
    this._returning = returning ?? ['*'];
  }

  public getReturning(): string[] {
    return this._returning;
  }

  public getColumn(): string[] {
    return this._column;
  }

  public getColumnsToUpdate() {
    return this._columnsToUpdate;
  }

  public getParent() {
    return this._parent;
  }

  public update(columns: string[] | RawQuery[]) {
    this._columnsToUpdate = columns;
    return this;
  }

  public then<TResult1, TResult2 = never>(onfulfilled?: (value: any) => TResult1 | PromiseLike<TResult1>, onrejected?: (reason: any) => TResult2 | PromiseLike<TResult2>): PromiseLike<TResult1 | TResult2> {
    return this._parent.then(onfulfilled, onrejected);
  }

  public toDB(): ICompilerOutput | ICompilerOutput[] {
    return this._parent.toDB();
  }
}

@NewInstance()
export class UpdateQueryBuilder<T> extends QueryBuilder<IUpdateResult> {
  /**
   * where query props
   */
  protected _statements: IQueryStatement[];
  protected _boolean: WhereBoolean;

  protected _value: {};
  public get Value(): {} {
    return this._value;
  }

  @use(WhereBuilder) this: this;

  constructor(container: Container, driver: OrmDriver, model: Constructor<any>) {
    super(container, driver, model);
    this._value = {};
    this._method = QueryMethod.UPDATE;
    this._boolean = WhereBoolean.AND;
    this._statements = [];

    this.QueryContext = QueryContext.Update;
  }

  public in(name: string) {
    this.setTable(name);
    return this;
  }

  public update(value: {}) {
    this._value = value;
    return this;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<UpdateQueryCompiler>(UpdateQueryCompiler, [this]).compile();
  }
}

@NewInstance()
export class InsertQueryBuilder extends QueryBuilder<IUpdateResult | any> {
  public DuplicateQueryBuilder: OnDuplicateQueryBuilder;

  protected _values: any[][];

  protected _columns: ColumnStatement[];

  protected _ignore: boolean;

  protected _update: boolean = false;

  protected _replace: boolean = false;

  protected _returning: string[];

  @use(ColumnsBuilder) this: this;

  public get Values() {
    return this._values;
  }

  public get Ignore() {
    return this._ignore;
  }

  public get Update() {
    return this._update;
  }

  public get Replace() {
    return this._replace;
  }

  constructor(container: Container, driver: OrmDriver, model: Constructor<any>) {
    super(container, driver, model);

    this._method = QueryMethod.INSERT;
    this._columns = [];
    this._values = [];

    this.QueryContext = QueryContext.Insert;
  }

  /**
   * Sets insert to ignore on duplicate
   */
  public orIgnore() {
    this._ignore = true;

    return this;
  }

  public orReplace() {
    this._replace = true;

    return this;
  }

  public returning(columns: string[]) {
    this._returning = columns;

    return this;
  }

  public values(data: {} | Array<{}>) {
    const self = this;

    if (Array.isArray(data)) {
      this.columns(_.chain(data).map(_.keys).flatten().uniq().value());

      data.forEach((d: any) => {
        _addData(d);
      });
    } else {
      this.columns(_.keysIn(data));
      _addData(data);
    }

    function _addData(d: any) {
      const binding: any[] = [];

      self._columns
        .filter((c) => !(c.Column instanceof RawQuery))
        .map((c) => {
          return c.Column;
        })
        .forEach((c: string) => {
          binding.push(d[c]);
        });

      self._values.push(binding);
    }

    return this;
  }

  public into(table: string, schema?: string) {
    this.setTable(table, schema);
    return this;
  }

  public onDuplicate(column?: string | string[]): OnDuplicateQueryBuilder {
    let columnToCheck = column;
    if (!columnToCheck && this._model) {
      const dsc = extractModelDescriptor(this._model);
      columnToCheck = dsc.Columns.filter((c) => c.Unique).map((c) => c.Name);
    }

    this._update = true;
    this.DuplicateQueryBuilder = new OnDuplicateQueryBuilder(this._container, this, columnToCheck, this._returning);
    this.QueryContext = QueryContext.Upsert;

    return this.DuplicateQueryBuilder;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<InsertQueryCompiler>(InsertQueryCompiler, [this]).compile();
  }
}

@NewInstance()
@Inject(Container)
export class IndexQueryBuilder extends Builder {
  public Name: string;
  public Unique: boolean;
  public Table: string;
  public Columns: string[];

  constructor(container: Container, driver: OrmDriver) {
    super(container, driver);

    this.QueryContext = QueryContext.Schema;
  }

  public name(name: string) {
    this.Name = name;

    return this;
  }

  public unique() {
    this.Unique = true;

    return this;
  }

  public table(name: string) {
    this.Table = name;

    return this;
  }

  public columns(colNames: string[]) {
    this.Columns = colNames;

    return this;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<IndexQueryCompiler>(IndexQueryCompiler, [this]).compile();
  }
}

@NewInstance()
export class ForeignKeyBuilder {
  public ForeignKeyField: string;

  public Table: string;

  public PrimaryKey: string;

  public OnDeleteAction: ReferentialAction;

  public OnUpdateAction: ReferentialAction;

  constructor() {
    this.OnDeleteAction = ReferentialAction.NoAction;
    this.OnUpdateAction = ReferentialAction.NoAction;
  }

  /**
   *
   * Referenced field in child table
   *
   * @param fkName - name of foreign field in child table
   */
  public foreignKey(fkName: string) {
    this.ForeignKeyField = fkName;

    return this;
  }

  /**
   *
   * Referenced parent table & key
   *
   * @param table - parent table
   * @param pKey - parant table key field
   */
  public references(table: string, pKey: string) {
    this.Table = table;
    this.PrimaryKey = pKey;

    return this;
  }

  /**
   *
   * On delete action
   *
   * @param action - action to take on delete
   */
  public onDelete(action: ReferentialAction) {
    this.OnDeleteAction = action;

    return this;
  }

  /**
   *
   * On update action
   *
   * @param action - action to take on update
   */
  public onUpdate(action: ReferentialAction) {
    this.OnUpdateAction = action;

    return this;
  }

  /**
   * Shorhand for on update and on delete cascade settings
   */
  public cascade() {
    this.OnUpdateAction = ReferentialAction.Cascade;
    this.OnDeleteAction = ReferentialAction.Cascade;

    return this;
  }
}

@NewInstance()
@Inject(Container)
export class ColumnQueryBuilder {
  public Name: string;
  public Unique: boolean;
  public Unsigned: boolean;
  public AutoIncrement: boolean;
  public Default: DefaultValueBuilder<ColumnQueryBuilder>;
  public PrimaryKey: boolean;
  public Comment: string;
  public Charset: string;
  public Collation: string;
  public NotNull: boolean;
  public Type: ColumnType;
  public Args: any[];

  constructor(protected container: IContainer, name: string, type: ColumnType, ...args: any[]) {
    this.Name = name;
    this.Type = type;
    this.Charset = '';
    this.Args = [];
    this.AutoIncrement = false;
    this.NotNull = false;
    this.Collation = '';
    this.Comment = '';
    this.Unique = false;
    this.Unsigned = false;

    this.Args.push(...args);
  }

  public notNull() {
    this.NotNull = true;

    return this;
  }

  public unique() {
    this.Unique = true;

    return this;
  }

  public unsigned() {
    this.Unsigned = true;

    return this;
  }

  public autoIncrement() {
    this.AutoIncrement = true;

    return this;
  }

  public default(): DefaultValueBuilder<ColumnQueryBuilder> {
    this.Default = this.container.resolve(DefaultValueBuilder<ColumnQueryBuilder>, [this]);
    return this.Default;
  }

  public primaryKey() {
    this.PrimaryKey = true;
    return this;
  }

  public comment(comment: string) {
    this.Comment = comment;

    return this;
  }

  public charset(charset: string) {
    this.Charset = charset;

    return this;
  }

  public collation(collation: string) {
    this.Collation = collation;

    return this;
  }
}

@Inject(Container)
@NewInstance()
export class AlterColumnQueryBuilder extends ColumnQueryBuilder {
  public AlterType: ColumnAlterationType;
  public AfterColumn: string;
  public OldName: string;

  constructor(container: IContainer, name: string, type: ColumnType, ...args: any[]) {
    super(container, name, type, ...args);
    this.OldName = name;

    // we assume add by default
    this.AlterType = ColumnAlterationType.Add;
  }

  public addColumn() {
    this.AlterType = ColumnAlterationType.Add;

    return this;
  }

  public modify() {
    this.AlterType = ColumnAlterationType.Modify;

    return this;
  }

  public rename(newName: string) {
    this.AlterType = ColumnAlterationType.Rename;
    this.Name = newName;
    return this;
  }

  public after(columnName: string) {
    this.AfterColumn = columnName;
    return this;
  }
}

@NewInstance()
export class TableExistsQueryBuilder extends QueryBuilder {
  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver, null);

    this.setTable(name);

    this.QueryContext = QueryContext.Select;
  }
  public toDB(): ICompilerOutput {
    return this._container.resolve<TableExistsCompiler>(TableExistsCompiler, [this]).compile();
  }
}

@NewInstance()
export class DropTableQueryBuilder extends QueryBuilder {
  public Exists: boolean;

  constructor(container: Container, driver: OrmDriver, name: string, database?: string) {
    super(container, driver, null);

    this.setTable(name);

    if (database) {
      this.database(database);
    }

    this.Exists = false;
    this.QueryContext = QueryContext.Schema;
  }

  public ifExists() {
    this.Exists = true;
    return this;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<DropTableCompiler>(DropTableCompiler, [this]).compile();
  }
}

@NewInstance()
export class AlterTableQueryBuilder extends QueryBuilder {
  protected _columns: ColumnQueryBuilder[];

  public NewTableName: string;

  public DroppedColumns: string[];

  public get Columns() {
    return this._columns;
  }

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver, null);

    this.setTable(name);

    this.QueryContext = QueryContext.Schema;
    this._columns = [];
    this.DroppedColumns = [];
  }

  public int: (name: string) => AlterColumnQueryBuilder;
  public bigint: (name: string) => AlterColumnQueryBuilder;
  public tinyint: (name: string) => AlterColumnQueryBuilder;
  public smallint: (name: string) => AlterColumnQueryBuilder;
  public mediumint: (name: string) => AlterColumnQueryBuilder;

  public text: (name: string) => AlterColumnQueryBuilder;
  public tinytext: (name: string) => AlterColumnQueryBuilder;
  public mediumtext: (name: string) => AlterColumnQueryBuilder;
  public smalltext: (name: string) => AlterColumnQueryBuilder;
  public longtext: (name: string) => AlterColumnQueryBuilder;
  public string: (name: string, length?: number) => AlterColumnQueryBuilder;

  public float: (name: string, precision?: number, scale?: number) => AlterColumnQueryBuilder;
  public double: (name: string, precision?: number, scale?: number) => AlterColumnQueryBuilder;
  public decimal: (name: string, precision?: number, scale?: number) => AlterColumnQueryBuilder;
  public boolean: (name: string) => AlterColumnQueryBuilder;
  public bit: (name: string) => AlterColumnQueryBuilder;

  public date: (name: string) => AlterColumnQueryBuilder;
  public dateTime: (name: string) => AlterColumnQueryBuilder;
  public time: (name: string) => AlterColumnQueryBuilder;
  public timestamp: (name: string) => AlterColumnQueryBuilder;
  public enum: (name: string, values: any[]) => AlterColumnQueryBuilder;
  public json: (name: string) => AlterColumnQueryBuilder;

  public binary: (name: string, size: number) => AlterColumnQueryBuilder;

  public tinyblob: (name: string) => AlterColumnQueryBuilder;
  public mediumblob: (name: string) => AlterColumnQueryBuilder;
  public longblob: (name: string) => AlterColumnQueryBuilder;

  /**
   * Renames table
   *
   * @param newTableName - new table name
   */
  public rename(newTableName: string) {
    this.NewTableName = newTableName;
  }

  public dropColumn(column: string) {
    this.DroppedColumns.push(column);
  }

  public toDB(): ICompilerOutput[] {
    return this._container.resolve<AlterTableQueryCompiler>(AlterTableQueryCompiler, [this]).compile();
  }
}

@NewInstance()
export class TableQueryBuilder extends QueryBuilder {
  public int: (name: string) => ColumnQueryBuilder;
  public bigint: (name: string) => ColumnQueryBuilder;
  public tinyint: (name: string) => ColumnQueryBuilder;
  public smallint: (name: string) => ColumnQueryBuilder;
  public mediumint: (name: string) => ColumnQueryBuilder;

  public text: (name: string) => ColumnQueryBuilder;
  public tinytext: (name: string) => ColumnQueryBuilder;
  public mediumtext: (name: string) => ColumnQueryBuilder;
  public smalltext: (name: string) => ColumnQueryBuilder;
  public longtext: (name: string) => ColumnQueryBuilder;
  public string: (name: string, length?: number) => ColumnQueryBuilder;

  /**
   * Alias for string(name, 36 )
   */
  public uuid(name: string) {
    return this.string(name, 36);
  }

  public float: (name: string, precision?: number, scale?: number) => ColumnQueryBuilder;
  public double: (name: string, precision?: number, scale?: number) => ColumnQueryBuilder;
  public decimal: (name: string, precision?: number, scale?: number) => ColumnQueryBuilder;
  public boolean: (name: string) => ColumnQueryBuilder;
  public bit: (name: string) => ColumnQueryBuilder;

  public date: (name: string) => ColumnQueryBuilder;
  public dateTime: (name: string) => ColumnQueryBuilder;
  public time: (name: string) => ColumnQueryBuilder;
  public timestamp: (name: string) => ColumnQueryBuilder;
  public enum: (name: string, values: any[]) => ColumnQueryBuilder;
  public json: (name: string) => ColumnQueryBuilder;

  public binary: (name: string, size: number) => ColumnQueryBuilder;

  public tinyblob: (name: string) => ColumnQueryBuilder;
  public mediumblob: (name: string) => ColumnQueryBuilder;
  public longblob: (name: string) => ColumnQueryBuilder;

  public ifExists(): TableQueryBuilder {
    this._checkExists = true;
    return this;
  }

  /**
   * Mark table as temporary
   */
  public temporary(): TableQueryBuilder {
    this._temporary = true;
    return this;
  }

  /**
   * Turn on history trackign for this table
   * Each change & row will be tracked, and all history of changes can be accessed
   */
  public trackHistory() {
    this._trackHistory = true;
    return this;
  }

  public set: (name: string, allowed: string[]) => ColumnQueryBuilder;

  public get Columns() {
    return this._columns;
  }

  public get ForeignKeys() {
    return this._foreignKeys;
  }

  protected _columns: ColumnQueryBuilder[];

  protected _foreignKeys: ForeignKeyBuilder[];

  protected _comment: string;

  protected _charset: string;

  protected _checkExists: boolean;

  protected _temporary: boolean;

  protected _trackHistory: boolean;

  public get CheckExists() {
    return this._checkExists;
  }

  public get Temporary() {
    return this._temporary;
  }

  public get TrackHistory() {
    return this._trackHistory;
  }

  constructor(container: Container, driver: OrmDriver, name: string) {
    super(container, driver, null);

    this._charset = '';
    this._comment = '';
    this._columns = [];
    this._foreignKeys = [];
    this._temporary = false;
    this._trackHistory = false;

    this.setTable(name);

    this.QueryContext = QueryContext.Schema;
  }

  public increments(name: string) {
    return this.int(name).autoIncrement().notNull().primaryKey();
  }

  public comment(comment: string) {
    this._comment = comment;
  }

  public charset(charset: string) {
    this._charset = charset;
  }

  public foreignKey(foreignKey: string) {
    const builder = new ForeignKeyBuilder();
    builder.foreignKey(foreignKey);
    this._foreignKeys.push(builder);

    return builder;
  }

  public toDB(): ICompilerOutput | ICompilerOutput[] {
    return this._container.resolve<TableQueryCompiler>(TableQueryCompiler, [this]).compile();
  }
}

@NewInstance()
@Inject(Container)
export class TruncateTableQueryBuilder extends QueryBuilder {
  constructor(protected container: Container, protected driver: OrmDriver) {
    super(container, driver);
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<TruncateTableQueryCompiler>(TruncateTableQueryCompiler, [this.Container, this]).compile();
  }
}

@NewInstance()
@Inject(Container)
export class CloneTableQueryBuilder extends QueryBuilder {
  protected _cloneSrc: string;

  protected _temporary: boolean;

  protected _shallow: boolean;

  protected _filter: SelectQueryBuilder;

  public get CloneSource() {
    return this._cloneSrc;
  }

  public get Temporary() {
    return this._temporary;
  }

  public get Shallow() {
    return this._shallow;
  }

  public get Filter() {
    return this._filter;
  }

  constructor(protected container: Container, protected driver: OrmDriver) {
    super(container, driver);

    this._shallow = true;
    this._cloneSrc = '';
    this._temporary = false;
  }

  /**
   * Clones table structure without data
   * Shorthand for createTable(( table) => table.clone("new"));
   *
   * @param srcTable - source table name
   * @param newTable - target table name
   */
  public shallowClone(srcTable: string, newTable: string) {
    this.setTable(newTable);
    this._cloneSrc = srcTable;

    return this;
  }

  /**
   * Clones table with data
   *
   * @param srcTable - source table name
   * @param newTable - target table name
   * @param filter - data filter, set null if all data is to be cloned
   */
  public async deepClone(srcTable: string, newTable: string, filter?: (query: SelectQueryBuilder) => void) {
    this.setTable(newTable);
    this._cloneSrc = srcTable;
    this._shallow = false;

    if (filter) {
      this._filter = new SelectQueryBuilder(this._container, this._driver);
      this._filter.setTable(this._cloneSrc);
      filter(this._filter);
    }

    return this;
  }

  public toDB(): ICompilerOutput[] {
    return this._container.resolve<TableCloneQueryCompiler>(TableCloneQueryCompiler, [this]).compile();
  }
}

export class EventIntervalDesc {
  public Year: number;
  public Month: number;
  public Minute: number;
  public Hour: number;
  public Second: number;

  public second(s: number) {
    this.Second = s;
  }

  public minute(m: number) {
    this.Minute = m;
  }

  public hour(h: number) {
    this.Hour = h;
  }

  public month(m: number) {
    this.Month = m;
  }

  public year(y: number) {
    this.Year = y;
  }
}

@NewInstance()
@Inject(Container)
export class EventQueryBuilder extends QueryBuilder {
  public EveryInterval: EventIntervalDesc;
  public FromNowInverval: EventIntervalDesc;
  public Comment: string;
  public At: DateTime;
  public RawSql: RawQueryStatement;
  public Queries: QueryBuilder[];

  constructor(protected container: Container, protected driver: OrmDriver, public Name: string) {
    super(container, driver);
  }

  /**
   * execute every time with specified interval ( days, hours, seconds, minutes etc)
   */
  public every() {
    this.EveryInterval = new EventIntervalDesc();
    return this.EveryInterval;
  }

  /**
   *
   * Execute at specific time
   *
   * @param dateTime - specific time
   */
  public at(dateTime: DateTime) {
    this.At = dateTime;
  }

  /**
   * execute once at specific interfal from now eg. now + 1 day
   */
  public fromNow() {
    this.FromNowInverval = new EventIntervalDesc();
    return this.FromNowInverval;
  }

  /**
   *
   * @param sql - code to execute,  could be raw sql query, single builder, or multiple builders that will be executed on by one
   */
  public do(sql: RawQueryStatement | QueryBuilder[] | QueryBuilder) {
    if (sql instanceof RawQueryStatement) {
      this.RawSql = sql;
    } else if (Array.isArray(sql)) {
      this.Queries = sql;
    } else {
      this.Queries = [sql];
    }
  }

  /**
   *
   * Add comment to schedule for documentation. It is passed to sql engine
   *
   * @param comment - comment text
   */
  public comment(comment: string) {
    this.Comment = comment;
  }

  public toDB(): ICompilerOutput[] {
    return this._container.resolve<EventQueryCompiler>(EventQueryCompiler, [this]).compile();
  }
}

@NewInstance()
@Inject(Container)
export class DropEventQueryBuilder extends QueryBuilder {
  constructor(protected container: Container, protected driver: OrmDriver, public Name: string) {
    super(container, driver);
  }

  public toDB(): ICompilerOutput[] {
    return this._container.resolve<DropEventQueryCompiler>(DropEventQueryCompiler, [this]).compile();
  }
}

/**
 * Creates schedule job in database engine.
 * Note, some engines does not support this, so it will implemented
 * as nodejs interval
 */
@NewInstance()
@Inject(Container)
export class ScheduleQueryBuilder {
  constructor(protected container: Container, protected driver: OrmDriver) {}

  public create(name: string, callback: (event: EventQueryBuilder) => void) {
    const builder = new EventQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);

    return builder;
  }

  public drop(name: string) {
    return new DropEventQueryBuilder(this.container, this.driver, name);
  }
}

@NewInstance()
@Inject(Container)
export class SchemaQueryBuilder {
  constructor(protected container: Container, protected driver: OrmDriver) {}

  public createTable(name: string, callback: (table: TableQueryBuilder) => void) {
    const builder = new TableQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);

    return builder;
  }

  public cloneTable(callback: (clone: CloneTableQueryBuilder) => void) {
    const builder = new CloneTableQueryBuilder(this.container, this.driver);
    callback(builder);
    return builder;
  }

  public alterTable(name: string, callback: (table: AlterTableQueryBuilder) => void) {
    const builder = new AlterTableQueryBuilder(this.container, this.driver, name);
    callback.call(this, builder);
    return builder;
  }

  public dropTable(name: string, schema?: string) {
    return new DropTableQueryBuilder(this.container, this.driver, name, schema);
  }

  public async tableExists(name: string, schema?: string) {
    const query = new TableExistsQueryBuilder(this.container, this.driver, name);

    if (schema) {
      query.database(schema);
    }

    const exists = await query;
    return exists !== null && exists.length === 1;
  }

  public event(name: string) {
    return new EventQueryBuilder(this.container, this.driver, name);
  }

  public dropEvent(name: string) {
    return new DropEventQueryBuilder(this.container, this.driver, name);
  }
}

Object.values(ColumnType).forEach((type) => {
  (TableQueryBuilder.prototype as any)[type] = function (this: TableQueryBuilder, name: string, ...args: any[]) {
    const _builder = new ColumnQueryBuilder(this.Container, name, type, ...args);
    this._columns.push(_builder);
    return _builder;
  };
});

Object.values(ColumnType).forEach((type) => {
  (AlterTableQueryBuilder.prototype as any)[type] = function (this: AlterTableQueryBuilder, name: string, ...args: any[]) {
    const _builder = new AlterColumnQueryBuilder(this.Container, name, type, ...args);
    this._columns.push(_builder);
    return _builder;
  };
});
