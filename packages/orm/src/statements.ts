import { IJoinStatementOptions } from './interfaces.js';
import type { SelectQueryBuilder, WhereBuilder, RawQuery, QueryBuilder } from './builders.js';
import { ColumnMethods, SqlOperator, WhereBoolean } from './enums.js';
import { NewInstance, Container, Class, Constructor, Inject, IContainer } from '@spinajs/di';
import _ from 'lodash';
import { IColumnDescriptor } from './interfaces.js';
import { ModelBase } from './model.js';
import { Lazy } from '@spinajs/util';
import { InvalidArgument } from '@spinajs/exceptions';
import { extractModelDescriptor } from './descriptor.js';

export interface IQueryStatementResult {
  Statements: string[];
  Bindings: any[];
}

export interface IQueryStatement {
  TableAlias: string;

  /**
   * Boolean connector that precedes this statement inside a WHERE/HAVING clause.
   * The very first statement in a clause has no leading connector (the value is
   * ignored). Subsequent statements are joined by their own connector, so
   * `where(a).where(b).orWhere(c)` compiles to `a AND b OR c`.
   */
  Boolean: WhereBoolean;

  // set by whereOnJoin() - statement is emitted in the relation JOIN ON clause
  // instead of parent query WHERE ( does not survive clone() )
  OnJoin?: boolean;

  build(): IQueryStatementResult;

  clone(parent?: QueryBuilder | SelectQueryBuilder | WhereBuilder<any>): IQueryStatement;
}

export abstract class QueryStatement implements IQueryStatement {
  protected _tableAlias: string | undefined;

  protected _boolean: WhereBoolean = WhereBoolean.AND;

  protected _onJoin: boolean = false;

  public get TableAlias(): string {
    return this._tableAlias ?? '';
  }

  public set TableAlias(alias: string) {
    this._tableAlias = alias;
  }

  public get Boolean(): WhereBoolean {
    return this._boolean;
  }

  public set Boolean(op: WhereBoolean) {
    this._boolean = op;
  }

  public get OnJoin(): boolean {
    return this._onJoin;
  }

  public set OnJoin(onJoin: boolean) {
    this._onJoin = onJoin;
  }

  constructor(tableAlias?: string | null) {
    this._tableAlias = tableAlias ?? undefined;
  }

  public abstract build(): IQueryStatementResult;

  public abstract clone<T extends QueryBuilder | SelectQueryBuilder | WhereBuilder<any>>(parent?: T): IQueryStatement;
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

    this._expr = expression;
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
  constructor(protected callback: Lazy<unknown>, protected context: unknown) {
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
      const columnName = typeof column === 'string' ? column : null;
      const columnDesc = columnName && desc ? desc.Columns.find((x) => x.Name === columnName) : null;

      // Allow primary key columns and any model property even if not explicitly in Columns array
      // Some properties may be defined without decorators or only with @Primary
      if (columnName && !columnDesc && !desc?.PrimaryKey.includes(columnName) && !(columnName in this._model.prototype)) {
        throw new InvalidArgument(`column ${columnName} not exists in model ${this._model.name}`);
      }

      this._isAggregate = columnDesc?.Aggregate ?? false;
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
  protected _whereBuilder: SelectQueryBuilder<any>;

  protected _container: IContainer;

  constructor(protected _options: IJoinStatementOptions) {
    super(_options.sourceTableAlias);

    if ((_.isFunction(_options.callback) || _options.callback instanceof Lazy) && _options.joinModel) {
      const joinModelDescriptor = extractModelDescriptor(_options.joinModel);
      const driver = joinModelDescriptor!.Driver!;
      const container = joinModelDescriptor!.Driver!.Container;

      this._whereBuilder = container.resolve<SelectQueryBuilder>('SelectQueryBuilder', [driver, _options.joinModel, this]);
      this._whereBuilder.database(driver.Options.Database!);
      this._whereBuilder.where(_options.callback!);

      if (_options.queryCallback) {
        _options.queryCallback.call(this._whereBuilder);
      }

      // Merge columns/sort from the join sub-builder, but NOT its WHERE
      // statements — those are emitted in the JOIN's ON clause by build() so a
      // LEFT JOIN stays a LEFT JOIN (otherwise the condition lands in the main
      // WHERE and filters out rows the outer join is meant to keep).
      this._options.builder!.mergeBuilder(this._whereBuilder, false);
    }
  }

  public abstract build(): IQueryStatementResult;

  /**
   * Namespaces this join under a populated relation's alias, and only when the alias was not
   * given explicitly: a `populate('Client', cb)` and `populate('Agency', cb)` that each join
   * the same model would otherwise both synthesise `$Model$` and collide in the parent query
   * ( "Not unique table/alias" ). `$Client$` + `TestScope` becomes `$Client.TestScope$`.
   */
  public nestUnder(ownerAlias: string, separator: string): void {
    if (this._options.joinTableAlias || !this._options.joinModel) {
      return;
    }

    const descriptor = extractModelDescriptor(this._options.joinModel);
    if (!descriptor) {
      return;
    }

    const owner = separator ? ownerAlias.split(separator).join('') : ownerAlias;
    this._options.joinTableAlias = `${separator}${owner}.${descriptor.Name}${separator}`;
  }
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

/**
 * Membership test against a `@Set()` column — a single column holding several values
 * joined by {@link SET_DELIMITER} ( see the SetValueConverter ).
 *
 * There is no portable SQL for this. MySQL has `FIND_IN_SET`, SQLite has `instr`,
 * MSSQL has `CHARINDEX`, and the shared implementation falls back to `LIKE`. Each
 * driver therefore registers its own subclass; whatever a driver does not register
 * resolves to the portable one, which is correct everywhere and merely slower.
 *
 * The value rules below are shared because they are a property of the STORAGE
 * FORMAT, not of any dialect: a value containing the delimiter cannot be
 * represented in such a column at all, and every implementation must refuse it
 * rather than emit a query that matches neighbouring entries.
 */
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

  /**
   * The values to test, as strings, after rejecting anything the storage format
   * cannot express.
   *
   * A value containing the delimiter is refused instead of being searched for:
   * `whereInSet('Role', ['admin,user'])` can only ever be a caller mistake, and
   * every implementation of this statement — `FIND_IN_SET` included — would
   * answer it by matching a row holding `admin` next to `user`.
   */
  protected values(): string[] {
    return this._val.map((v) => {
      if (v === null || v === undefined) {
        throw new InvalidArgument(`set membership value cannot be null or undefined ( column ${this._column} )`);
      }

      const value = String(v);

      if (value.includes(SET_DELIMITER)) {
        throw new InvalidArgument(`set membership value "${value}" contains the set delimiter "${SET_DELIMITER}" and cannot be stored in, or matched against, column ${this._column}`);
      }

      return value;
    });
  }

  /**
   * Joins the per-value expressions into one statement.
   *
   * Negation is per value and AND-ed: "in none of these", which is the mirror of
   * the OR-ed positive form.
   */
  protected combine(expressions: string[]): string {
    if (expressions.length === 0) {
      // An empty value list matches nothing, and its negation matches
      // everything. Spelled out so the caller gets a valid query rather than an
      // empty parenthesis the driver rejects.
      return this._not ? '(1 = 1)' : '(1 = 0)';
    }

    return this._not ? `(${expressions.map((e) => `NOT ${e}`).join(' AND ')})` : `(${expressions.join(' OR ')})`;
  }
}

/**
 * Delimiter a `@Set()` column is stored with. Must agree with the SetValueConverter,
 * which joins on it.
 */
export const SET_DELIMITER = ',';

/**
 * Escape character for the LIKE patterns of the portable membership test.
 *
 * NOT a backslash: MySQL treats a backslash as an escape inside string literals of
 * its own, so `ESCAPE '\'` is a syntax error there and `ESCAPE '\\'` means something
 * different again depending on `NO_BACKSLASH_ESCAPES`. A character with no special
 * meaning in any of the three dialects avoids the whole question.
 */
export const LIKE_ESCAPE_CHARACTER = '~';

/**
 * Escapes the LIKE metacharacters of a value that is going to be embedded in a
 * pattern, so a role literally named `admin_1` does not also match `adminX1`.
 */
export function escapeLikeValue(value: string): string {
  return value.replace(new RegExp(`[${LIKE_ESCAPE_CHARACTER}%_]`, 'g'), (c) => `${LIKE_ESCAPE_CHARACTER}${c}`);
}
@NewInstance()
export abstract class ColumnStatement extends QueryStatement {
  protected _column: string | RawQuery;
  protected _alias: string;
  protected _descriptor: IColumnDescriptor | undefined | null;

  constructor(column: string | RawQuery, alias: string, tableAlias: string, descriptor: IColumnDescriptor | undefined | null) {
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

  public get TableAlias(): string {
    return this._tableAlias ?? '';
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
    super(column, alias, tableAlias, undefined);
    this._method = method;
  }

  public abstract build(): IQueryStatementResult;
}
