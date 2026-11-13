import { Container, NewInstance } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { use } from 'typescript-mix';
import { QueryMethod, WhereBoolean } from '../enums.js';
import { UpdateQueryCompiler, QueryContext } from '../interfaces.js';
import type { ICompilerOutput, IUpdateResult, IUpdateQueryBuilder } from '../interfaces.js';
import type { IQueryStatement } from '../statements.js';
import type { Unbox } from '../types.js';
import type { ColumnRef, DeclaredColumn, LiteralColumn } from '../typing.js';
import type { OrmDriver } from '../driver.js';
import { isNullOrWhitespace } from '@spinajs/util';
import { assertNarrowed } from './internal.js';
import { QueryBuilder } from './base.js';
import { WhereBuilder } from './where.js';

export interface UpdateQueryBuilder<T> extends IUpdateQueryBuilder<T> { }

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

  protected _increments: Map<string, number>;

  /** Columns to increment and by how much, compiled after {@link Value}. */
  public get Increments(): ReadonlyMap<string, number> {
    return this._increments;
  }

  @use(WhereBuilder) this: this;

  constructor(container: Container, driver: OrmDriver, model: Constructor<any>) {
    super(container, driver, model);
    this._value = {};
    this._increments = new Map();
    this._method = QueryMethod.UPDATE;
    this._boolean = WhereBoolean.AND;
    this._statements = [];

    this.QueryContext = QueryContext.Update;

    // Query middlewares (e.g. rbac ownership enforcement) must run for updates
    // too, not only selects — otherwise :own permission constraints are never
    // applied and any row can be updated.
    this._queryMiddlewares.forEach((x) => x.afterQueryCreation(this));
  }

  public in(name: string) {
    this.setTable(name);
    return this;
  }

  public update(value: {}) {
    this._value = value;
    return this;
  }

  public increment(column: DeclaredColumn<Unbox<T>>, by?: number): this;
  public increment<C extends ColumnRef<Unbox<T>>>(column: LiteralColumn<Unbox<T>, C>, by?: number): this;
  public increment(column: string, by = 1): this {
    if (isNullOrWhitespace(column)) {
      throw new InvalidArgument('increment column is empty');
    }

    if (typeof by !== 'number' || !Number.isFinite(by)) {
      throw new InvalidArgument(`increment of ${column} must be a finite number, got ${String(by)}`);
    }

    this._increments.set(column, (this._increments.get(column) ?? 0) + by);
    return this;
  }

  protected _whereFloor?: number;

  /** Refuses to execute until the caller adds a WHERE; constraints already present (middleware ones) do not count. */
  public requireWhere(): this {
    this._whereFloor = this._statements.length;
    return this;
  }

  protected async _run(): Promise<IUpdateResult> {
    assertNarrowed('UPDATE', this.Table, this._statements, this._whereFloor);
    return super._run();
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<UpdateQueryCompiler>(UpdateQueryCompiler, [this]).compile();
  }
}
