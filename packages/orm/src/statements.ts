import { SelectQueryBuilder, WhereBuilder, RawQuery } from './builders';
import { ColumnMethods, WhereOperators, JoinMethod } from './enums';
import { NewInstance, Container } from '@spinajs/di';
import _ from 'lodash';
import { IColumnDescriptor } from './interfaces';

export interface IQueryStatementResult {
  Statements: string[];
  Bindings: any[];
}

export interface IQueryStatement {
  TableAlias: string;

  build(): IQueryStatementResult;
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
export abstract class WithRecursiveStatement extends QueryStatement {
  constructor(
    protected _name: string,
    protected _query: SelectQueryBuilder,
    protected _rcKeyName: string,
    protected _pkName: string,
  ) {
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
  protected _builder: WhereBuilder;

  constructor(builder: WhereBuilder, tableAlias: string) {
    super(tableAlias);
    this._builder = builder;
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class WhereStatement extends QueryStatement {
  protected _column: string | Wrap
  protected _operator: WhereOperators;
  protected _value: any;
  protected _container : Container;

  constructor(column: string, operator: WhereOperators, value: any, tableAlias: string, container: Container) {
    super(tableAlias);
    this._column = column;
    this._operator = operator;
    this._value = value;
    this._container = container;
  }

  public abstract build(): IQueryStatementResult;
}

export class Wrap {
  public Column: string;
  public Wrapper: Class<WrapStatement>


  constructor(column: string, wrapper: Class<WrapStatement>) {
    this.Column = column;
    this.Wrapper = wrapper;
  }
}

@NewInstance()
export abstract class WrapStatement {
  protected _value: any;
  protected _tableAlias : string;

  constructor(value: any, tableAlias: string) {
    this._tableAlias = tableAlias;
    this._value = value;
  }

  public abstract wrap() : string;
}

@NewInstance()
export abstract class DateWrapper extends WrapStatement {

}

@NewInstance()
export abstract class DateTimeWrapper extends WrapStatement {

}

@NewInstance()
export abstract class JoinStatement extends QueryStatement {
  protected _table: string;
  protected _method: JoinMethod;
  protected _foreignKey: string;
  protected _primaryKey: string;
  protected _query: RawQuery;
  protected _alias: string;
  protected _tableAlias: string;

  constructor(
    table: string | RawQuery,
    method: JoinMethod,
    foreignKey: string,
    primaryKey: string,
    alias: string,
    tableAlias: string,
  ) {
    super(tableAlias);

    this._method = method;

    if (_.isString(table)) {
      this._table = table;
      this._foreignKey = foreignKey;
      this._primaryKey = primaryKey;
      this._alias = alias;
      this._tableAlias = tableAlias;
    } else {
      this._query = table;
    }
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class InStatement extends QueryStatement {
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
  protected _tableAlias: string;
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
    if (this._column instanceof RawQuery) {
      return false;
    }

    return this._column && this._column.trim() === '*';
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

  constructor(column: string, method: ColumnMethods, alias: string, tableAlias: string) {
    super(column, alias, tableAlias, null);
    this._method = method;
  }

  public abstract build(): IQueryStatementResult;
}
