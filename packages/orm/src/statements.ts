import { IJoinStatementOptions } from './interfaces.js';
import type { SelectQueryBuilder, WhereBuilder, RawQuery, QueryBuilder } from './builders.js';
import { ColumnMethods, SqlOperator } from './enums.js';
import { NewInstance, Container, Class, Constructor, Inject, IContainer } from '@spinajs/di';
import _ from 'lodash';
import { IColumnDescriptor } from './interfaces.js';
import { extractModelDescriptor, ModelBase } from './model.js';
import { Lazy } from '@spinajs/util';
import { InvalidArgument } from '@spinajs/exceptions';

export interface IQueryStatementResult {
  Statements: string[];
  Bindings: any[];
}

export interface IQueryStatement {
  TableAlias: string;

  build(): IQueryStatementResult;

  clone(parent: QueryBuilder | SelectQueryBuilder | WhereBuilder<any>): IQueryStatement;
}

export abstract class QueryStatement implements IQueryStatement {
  protected _tableAlias: string;

  public get TableAlias() {
    return this._tableAlias;
  }

  public set TableAlias(alias: string) {
    this._tableAlias = alias;
  }

  constructor(tableAlias?: string) {
    this._tableAlias = tableAlias;
  }

  public abstract build(): IQueryStatementResult;

  public abstract clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent: T): IQueryStatement;
}

@NewInstance()
export abstract class RawQueryStatement extends QueryStatement {
  protected _query: string;
  protected _bindings: any[];

  constructor(query: string, bindings?: any[]) {
    super();

    this._query = query || '';
    this._bindings = bindings || [];
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
@Inject(Container)
export abstract class WithRecursiveStatement extends QueryStatement {
  constructor(protected container: IContainer, protected _name: string, protected _query: SelectQueryBuilder, protected _rcKeyName: string, protected _pkName: string) {
    super(null);
  }

  public abstract build(): IQueryStatementResult;
}
@NewInstance()
export abstract class GroupByStatement extends QueryStatement {
  protected _expr: string | RawQuery;

  constructor(expression: string | RawQuery, tableAlias: string) {
    super(tableAlias);

    this._expr = expression || null;
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class BetweenStatement extends QueryStatement {
  protected _val: any[];
  protected _not: boolean;
  protected _column: string;

  constructor(column: string, val: any[], not: boolean, tableAlias: string) {
    super(tableAlias);

    this._val = val || [];
    this._not = not || false;
    this._column = column || '';
  }

  public abstract build(): IQueryStatementResult;
}
@NewInstance()
export abstract class WhereQueryStatement extends QueryStatement {
  protected _builder: WhereBuilder<any>;

  constructor(builder: WhereBuilder<any>) {
    super();
    this._builder = builder;
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class LazyQueryStatement extends QueryStatement {

  constructor(protected callback: Lazy<unknown>, protected context : unknown) {
    super();
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class WhereStatement extends QueryStatement {
  protected _column: string | Wrap;
  protected _operator: SqlOperator;
  protected _value: any;
  protected _container: Container;
  protected _model: Constructor<ModelBase>;
  protected _isAggregate: boolean = false;
  protected _builder: WhereBuilder<unknown>;

  public get Column() {
    return this._column;
  }

  public get Operator() {
    return this._operator;
  }

  public get Value() {
    return this._value;
  }

  public get IsAggregate() {
    return this._isAggregate;
  }


  constructor(column: string | Wrap, operator: SqlOperator, value: any, builder: WhereBuilder<unknown>) {
    super();
    this._column = column;
    this._operator = operator;
    this._value = value;
    this._container = builder.Container;
    this._model = builder.Model;
    this._builder = builder;

    if (this._model) {
      const desc = extractModelDescriptor(this._model);
      const columnDesc = desc.Columns.find((x) => x.Name === column)

      if (!columnDesc) {
        throw new InvalidArgument(`column ${column} not exists in model ${this._model.name}`);
      }

      this._isAggregate = desc.Columns.find((x) => x.Name === column).Aggregate;
    }

  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export class Wrap {
  public Column: string;
  public Wrapper: Class<WrapStatement>;

  constructor(column: string, wrapper: Class<WrapStatement>) {
    this.Column = column;
    this.Wrapper = wrapper;
  }
}

@NewInstance()
export abstract class WrapStatement {
  protected _value: any;
  protected _tableAlias: string;

  constructor(value: any, tableAlias: string) {
    this._tableAlias = tableAlias;
    this._value = value;
  }

  public abstract wrap(): string;
}

@NewInstance()
export abstract class DateWrapper extends WrapStatement { }

@NewInstance()
export abstract class DateTimeWrapper extends WrapStatement { }

@NewInstance()
export abstract class JoinStatement extends QueryStatement {

  protected _whereBuilder: SelectQueryBuilder<any>;

  protected _container: IContainer;


  constructor(protected _options: IJoinStatementOptions) {
    super(_options.sourceTableAlias);


    if ((_.isFunction(_options.callback) || _options.callback instanceof Lazy) && _options.joinModel) {

      const joinModelDescriptor = extractModelDescriptor(_options.joinModel);
      const driver = joinModelDescriptor.Driver;
      const container = joinModelDescriptor.Driver.Container;

      this._whereBuilder = container.resolve<SelectQueryBuilder>('SelectQueryBuilder', [driver, _options.joinModel, this]);
      this._whereBuilder.database(driver.Options.Database);
      this._whereBuilder.where(_options.callback);

      if(_options.queryCallback){
        _options.queryCallback.call(this._whereBuilder);
      }

      this._options.builder.mergeBuilder(this._whereBuilder);
    }
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class InStatement extends QueryStatement {
  protected _val: any[];
  protected _not: boolean;
  protected _column: string;
  protected _builder: SelectQueryBuilder<any>;

  constructor(column: string, val: any[], not: boolean, builder: SelectQueryBuilder<any>) {
    super();

    this._val = val || [];
    this._not = not || false;
    this._column = column || '';
    this._builder = builder;
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class SelectQueryStatement extends QueryStatement {
  protected _builder: SelectQueryBuilder;
  constructor(builder: SelectQueryBuilder, tableAlias?: string) {
    super(tableAlias);
    this._builder = builder;
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class ExistsQueryStatement extends SelectQueryStatement {
  protected _not: boolean;

  constructor(builder: SelectQueryBuilder, not: boolean) {
    super(builder);

    this._not = not || false;
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class InSetStatement extends QueryStatement {
  protected _val: any[];
  protected _not: boolean;
  protected _column: string;

  constructor(column: string, val: any[], not: boolean, tableAlias: string) {
    super(tableAlias);

    this._val = val || [];
    this._not = not || false;
    this._column = column || '';
  }

  public abstract build(): IQueryStatementResult;
}
@NewInstance()
export abstract class ColumnStatement extends QueryStatement {
  protected _column: string | RawQuery;
  protected _alias: string;
  protected _descriptor: IColumnDescriptor;

  constructor(column: string | RawQuery, alias: string, tableAlias: string, descriptor: IColumnDescriptor) {
    super(tableAlias);

    this._column = column || '';
    this._alias = alias || '';
    this._tableAlias = tableAlias;
    this._descriptor = descriptor;
  }

  public get Descriptor() {
    return this._descriptor;
  }

  public get Column() {
    return this._column;
  }

  public get Alias() {
    return this._alias;
  }

  public get TableAlias() {
    return this._tableAlias;
  }

  public set TableAlias(alias: string) {
    this._tableAlias = alias;
  }

  get IsWildcard() {
    if (this._column.constructor.name === 'RawQuery') {
      return false;
    }

    return this._column && (this._column as any).trim() === '*';
  }

  public abstract build(): IQueryStatementResult;
}

export abstract class ColumnRawStatement extends QueryStatement {
  constructor(public RawQuery: RawQuery) {
    super();
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class ColumnMethodStatement extends ColumnStatement {
  protected _method: ColumnMethods;

  constructor(column: string | RawQuery, method: ColumnMethods, alias: string, tableAlias: string) {
    super(column, alias, tableAlias, null);
    this._method = method;
  }

  public abstract build(): IQueryStatementResult;
}
