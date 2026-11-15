import { Container, NewInstance } from '@spinajs/di';
import type { Constructor } from '@spinajs/di';
import { use } from 'typescript-mix';
import { QueryMethod, WhereBoolean } from '../enums.js';
import { DeleteQueryCompiler, QueryContext } from '../interfaces.js';
import type { ICompilerOutput, IQueryLimit, IUpdateResult, IDeleteQueryBuilder } from '../interfaces.js';
import type { IQueryStatement } from '../statements.js';
import type { OrmDriver } from '../driver.js';
import { assertNarrowed } from './internal.js';
import { QueryBuilder } from './base.js';
import { LimitBuilder } from './limit.js';
import { WhereBuilder } from './where.js';

export interface DeleteQueryBuilder<T> extends IDeleteQueryBuilder<T> { }

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

    // Query middlewares (e.g. rbac ownership enforcement) must run for deletes
    // too, not only selects — otherwise :own permission constraints are never
    // applied and any row can be deleted.
    this._queryMiddlewares.forEach((x) => x.afterQueryCreation(this));
  }

  protected _whereFloor?: number;

  /** Refuses to execute until the caller adds a WHERE; constraints already present (middleware ones) do not count. */
  public requireWhere(): this {
    this._whereFloor = this._statements.length;
    return this;
  }

  protected async _run(): Promise<IUpdateResult> {
    assertNarrowed('DELETE', this.Table, this._statements, this._whereFloor);
    return super._run();
  }

  public toDB(): ICompilerOutput {
    return this._container.resolve<DeleteQueryCompiler>(DeleteQueryCompiler, [this]).compile();
  }
}
