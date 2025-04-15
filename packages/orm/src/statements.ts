import { ISelectQueryBuilder } from './interfaces.js';
import type { SelectQueryBuilder, WhereBuilder, RawQuery } from './builders.js';
import { ColumnMethods, SqlOperator, JoinMethod } from './enums.js';
import { NewInstance, Container, Class, Constructor, Inject, IContainer } from '@spinajs/di';
import _ from 'lodash';
import { IColumnDescriptor } from './interfaces.js';
import { extractModelDescriptor, ModelBase } from './model.js';
import { OrmException } from './exceptions.js';
import { Lazy } from '@spinajs/util';

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

  constructor(builder: WhereBuilder<any>, tableAlias: string) {
    super(tableAlias);
    this._builder = builder;
  }

  public abstract build(): IQueryStatementResult;
}

@NewInstance()
export abstract class LazyQueryStatement extends QueryStatement { 
  
  constructor(protected callback : Lazy<unknown>){
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

  constructor(column: string, operator: SqlOperator, value: any, tableAlias: string, container: Container, model: Constructor<ModelBase>) {
    super(tableAlias);
    this._column = column;
    this._operator = operator;
    this._value = value;
    this._container = container;
    this._model = model;

    if (this._model) {
      const desc = extractModelDescriptor(model);
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
export abstract class DateWrapper extends WrapStatement {}

@NewInstance()
export abstract class DateTimeWrapper extends WrapStatement {}

@NewInstance()
export abstract class JoinStatement extends QueryStatement {
  protected _table: string;
  protected _method: JoinMethod;
  protected _foreignKey: string;
  protected _primaryKey: string;
  protected _query: RawQuery;
  protected _alias: string;
  protected _model: Constructor<ModelBase>;
  protected _sourceModel: Constructor<ModelBase>;
  protected _whereCallback: (this: ISelectQueryBuilder<any>) => void;
  protected _builder: SelectQueryBuilder<any>;
  protected _whereBuilder: SelectQueryBuilder<any>;
  protected _database: string;

  constructor(builder: SelectQueryBuilder<any>, sourceModel: Constructor<ModelBase>, table: string | RawQuery | Constructor<ModelBase>, method: JoinMethod, foreignKey: string | ((this: SelectQueryBuilder) => void), primaryKey: string, alias: string, tableAlias: string, database?: string) {
    super(tableAlias);

    this._method = method;
    this._builder = builder;

    if (_.isString(foreignKey)) {
      this._foreignKey = foreignKey;
    }

    if (_.isString(table)) {
      this._table = table;
      this._primaryKey = primaryKey;
      this._alias = tableAlias;
      this._tableAlias = alias;
      this._database = database;
    } else if (table.constructor.name === 'RawQuery') {
      this._query = table as any;
    } else {
      this._model = table as any;
      this._sourceModel = sourceModel;

      const sDesc = extractModelDescriptor(this._sourceModel);
      const tDesc = extractModelDescriptor(this._model);
      const sAlias = `${sDesc.Driver.Options.AliasSeparator}${sDesc.Name}${sDesc.Driver.Options.AliasSeparator}`;
      this._tableAlias = `${sDesc.Driver.Options.AliasSeparator}${tDesc.Name}${sDesc.Driver.Options.AliasSeparator}`;
      this._database = tDesc.Driver.Options.Database;

      if (!this._builder.TableAlias) {
        this._builder.setAlias(sAlias);
      }

      if (_.isFunction(foreignKey)) {
        this._whereCallback = foreignKey;

        const driver = this._builder.Driver;
        const cnt = driver.Container;
        this._whereBuilder = cnt.resolve<SelectQueryBuilder>('SelectQueryBuilder', [driver, this._model, this]);
        this._whereBuilder.setAlias(this._tableAlias);
        this._whereBuilder.database(driver.Options.Database);

        this._whereCallback.call(this._whereBuilder, [this]);

        this._builder.mergeBuilder(this._whereBuilder);
      }

      const relation = Array.from(sDesc.Relations, ([key, value]) => ({ key, value })).find((x) => x.value.TargetModel.name === this._model.name);

      if (!relation) {
        throw new OrmException(`Cannot find relation between ${this._model.name} and ${this._sourceModel.name}, thus cannot perform join statement`);
      }

      this._table = tDesc.TableName;
      this._primaryKey = tDesc.PrimaryKey;
      this._alias = sAlias;

      this._foreignKey = relation.value.ForeignKey;
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

  constructor(column: string, method: ColumnMethods, alias: string, tableAlias: string) {
    super(column, alias, tableAlias, null);
    this._method = method;
  }

  public abstract build(): IQueryStatementResult;
}
