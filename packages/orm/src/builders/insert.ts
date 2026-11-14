import { Container, NewInstance } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { NotSupported } from '@spinajs/exceptions';
import { OrmException } from '../exceptions.js';
import _ from 'lodash';
import { use } from 'typescript-mix';
import { QueryMethod } from '../enums.js';
import { InsertQueryCompiler, QueryContext } from '../interfaces.js';
import type { IColumnsBuilder, ICompilerOutput, IUpdateResult } from '../interfaces.js';
import type { ColumnStatement } from '../statements.js';
import type { OrmDriver } from '../driver.js';
import { extractModelDescriptor } from '../descriptor.js';
import { RawQuery } from './raw.js';
import { QueryBuilder } from './base.js';
import { ColumnsBuilder } from './columns.js';
import { OnDuplicateQueryBuilder } from './on-duplicate.js';

/**
 *  Trick typescript by using the inbuilt interface inheritance and declaration merging
 *  for builder classes.
 *
 *  We use mixins to extend functionality of builder eg. insert query builder uses function from columns builder
 *  and so on...
 */
export interface InsertQueryBuilder extends IColumnsBuilder { }

/**
 * Folds the driver results of one insert run as several statements into what one statement
 * would have returned: rows in insert order, counts summed, the last statement's identity value.
 */
export function mergeInsertResults(results: unknown[]): unknown {
  if (results.every((r) => Array.isArray(r))) {
    return (results as unknown[][]).flat();
  }

  const packets = results as Array<{ RowsAffected?: number; LastInsertId?: number; Returning?: unknown[] } | undefined>;

  return {
    RowsAffected: packets.reduce((sum, r) => sum + (r?.RowsAffected ?? 0), 0),
    LastInsertId: packets[packets.length - 1]?.LastInsertId ?? 0,
    Returning: packets.flatMap((r) => (Array.isArray(r?.Returning) ? r.Returning : [])),
  };
}

@NewInstance()
export class InsertQueryBuilder extends QueryBuilder<IUpdateResult> {
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

  /** Columns requested via {@link returning}. Empty when no RETURNING clause was asked for. */
  public get Returning() {
    return this._returning ?? [];
  }

  constructor(container: Container, driver: OrmDriver, model: Constructor<any>) {
    super(container, driver, model);

    this._method = QueryMethod.INSERT;
    this._columns = [];
    this._values = [];

    this.QueryContext = QueryContext.Insert;

    // Inserts get the same middleware pass as the other three builders. Note that a
    // middleware which needs to see or amend the row payload must use
    // `beforeQueryExecution` instead — at construction time `values()` has not been called.
    this._queryMiddlewares.forEach((x) => x.afterQueryCreation(this));
  }

  /**
   * The value of `column` on every row about to be inserted, in row order. Empty when the
   * payload does not carry that column at all.
   *
   * The read counterpart of {@link forceColumn}, and the only sane way for a
   * `beforeQueryExecution` hook to inspect what is being written: the payload lives in two
   * parallel structures ( `_columns` and one array per row ), so every caller would
   * otherwise repeat the same index lookup.
   *
   * @param column - column to read off each row
   */
  public getColumnValues(column: string): unknown[] {
    const index = this._columns.findIndex((c) => !(c.Column instanceof RawQuery) && c.Column === column);

    if (index === -1) {
      return [];
    }

    // eslint-disable-next-line security/detect-object-injection
    return this._values.map((row) => row[index]);
  }

  /**
   * Forces `column` to `value` on every row of the payload, overwriting whatever the caller
   * supplied.
   *
   * This is the write path for a policy that must not be negotiable — rbac's `createOwn`
   * ownership stamp. `values()` cannot serve: it appends rows and takes the column list from
   * its own argument, so calling it a second time adds a row rather than amending the
   * existing ones.
   *
   * @param column - column to overwrite on every row
   * @param value - value to force
   */
  public forceColumn(column: string, value: unknown): this {
    const existing = this._columns.findIndex((c) => !(c.Column instanceof RawQuery) && c.Column === column);

    if (existing === -1) {
      this.columns([...this._columns.filter((c) => !(c.Column instanceof RawQuery)).map((c) => c.Column as string), column]);
      this._values.forEach((row) => row.push(value));
      return this;
    }

    // eslint-disable-next-line security/detect-object-injection
    this._values.forEach((row) => (row[existing] = value));

    return this;
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

  /**
   * Asks the dialect to echo the given columns of every inserted row back.
   *
   * @throws NotSupported on drivers whose `supportedFeatures().insertReturning` is false —
   *         silently doing nothing is how this API was a no-op on MySQL and MSSQL for years.
   */
  public returning(columns: string[]) {
    if (!this.Driver.supportedFeatures().insertReturning) {
      throw new NotSupported(`driver ${this.Driver.Options.Driver} does not support RETURNING on INSERT`);
    }

    this._returning = columns;

    // onDuplicate() sets Upsert unconditionally and wins if it runs afterwards.
    if (this.QueryContext === QueryContext.Insert) {
      this.QueryContext = QueryContext.InsertReturning;
    }

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
        .forEach((c) => {
          binding.push(d[c as string]);
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
      columnToCheck = dsc!.Columns.filter((c) => c.Unique).map((c) => c.Name);
    }

    this._update = true;
    this.DuplicateQueryBuilder = new OnDuplicateQueryBuilder(this._container, this, columnToCheck, this._returning);
    this.QueryContext = QueryContext.Upsert;

    return this.DuplicateQueryBuilder;
  }

  /**
   * The payload as one builder per statement, each within the driver's `MaxBindings` and
   * `MaxInsertRows`. A payload that fits one statement is this builder alone.
   */
  public splitByDriverLimits(): InsertQueryBuilder[] {
    const maxBindings = this._driver.MaxBindings;
    const perRow = Math.max(this._columns.length, 1);
    // raw ON CONFLICT / ON DUPLICATE KEY columns bind once per statement, not once per row
    const reserved = _.flatMap(this.DuplicateQueryBuilder?.getColumnsToUpdate() ?? [], (c: string | RawQuery): unknown[] => (c instanceof RawQuery ? c.Bindings ?? [] : [])).length;
    const rowsPerStatement = Math.min(this._driver.MaxInsertRows,Math.floor((maxBindings - reserved) / perRow));

    if (this._values.length <= rowsPerStatement) {
      return [this];
    }

    if (rowsPerStatement < 1) {
      throw new OrmException(`one row of ${perRow} columns needs more than the ${maxBindings} bound parameters driver ${this._driver.Options.Driver} allows in a statement`);
    }

    const chunks: InsertQueryBuilder[] = [];
    for (let i = 0; i < this._values.length; i += rowsPerStatement) {
      chunks.push(this.withRows(this._values.slice(i, i + rowsPerStatement)));
    }

    return chunks;
  }

  protected _executeOnDriver(): Promise<IUpdateResult> {
    const chunks = this.splitByDriverLimits();

    if (chunks.length === 1) {
      return super._executeOnDriver();
    }

    const run = async () => {
      const results: unknown[] = [];
      for (const chunk of chunks) {
        results.push(await this._driver.execute(chunk));
      }

      return mergeInsertResults(results) as IUpdateResult;
    };

    // the statements are one insert to the caller: they commit or roll back together
    return this._driver.CurrentTransaction ? run() : this._driver.transaction(run);
  }

  /** A shallow copy that compiles `rows` instead of the whole payload; it is never executed itself. */
  private withRows(rows: any[][]): InsertQueryBuilder {
    const chunk = Object.assign(Object.create(Object.getPrototypeOf(this)), this) as InsertQueryBuilder;
    chunk._values = rows;
    chunk._executionPromise = null;
    return chunk;
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<InsertQueryCompiler>(InsertQueryCompiler, [this]).compile();
  }
}
