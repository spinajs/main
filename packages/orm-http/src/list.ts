import { IModelDescriptor, IQueryStatement, ISelectQueryBuilder, IWhereBuilder, ModelBase, SelectQueryBuilder, SortOrder } from '@spinajs/orm';
import { InvalidArgument, InvalidOption } from '@spinajs/exceptions';
import { CanceledException } from '@spinajs/util';
import './builders.js';
import { readAggregateRows } from './aggregate.js';
import { IAggregateColumns, IAggregateRequest, IFilterEntry, IFilterRequest, isFilterGroup } from './interfaces.js';
import { PageOptions, readPage, readSorting } from './paging.js';

export interface IListRequest {
  filter?: IFilterRequest;
  /** `{ limit, page }` or `{ limit, offset }`; a `limit` of 0 answers no rows. */
  pagination?: unknown;
  sorting?: { by?: unknown };
  aggregate?: IAggregateRequest;
  /** Already checked against the model's includable relations (`@Include`, `readInclude`). */
  include?: string[];
}

export interface IListOptions extends PageOptions {
  /** The last sort, which keeps pages from overlapping. Default: the first primary key column ascending. */
  fallbackSort?: { column: string; order?: SortOrder };

  /**
   * Restricts every statement the list runs: the count, the page and the aggregates. What it adds becomes one
   * condition ANDed with the request's filter, e.g. `(q) => q.where('TenantId', tenant)` or, with
   * `@spinajs/authz-orm`, `(q) => q.accessible('order.read')`.
   */
  scope?: (query: SelectQueryBuilder<any>) => void;

  /**
   * The only columns the rows answer, besides the primary key. A request that filters, sorts, groups or measures
   * by another column is refused, so a hidden column cannot be probed; `include` is refused too.
   */
  columns?: readonly string[];

  /** Checked before each statement. The ORM cannot cancel a statement, so the one in flight runs to its end. */
  signal?: AbortSignal;
}

export interface IListAnswer<T> {
  rows: T[];
  total: number;
  aggregates?: Record<string, unknown>[];
}

type Query = ISelectQueryBuilder<unknown>;

/** The builder's statement list, which the ORM offers no public way to regroup. */
interface Statements {
  _statements: IQueryStatement[];
}

function checkSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CanceledException('The list was canceled', signal.reason);
  }
}

function applyScope(query: Query, scope: IListOptions['scope']): void {
  if (!scope) {
    return;
  }

  const statements = (query as unknown as Statements)._statements;
  const before = statements.length;
  scope(query as unknown as SelectQueryBuilder<any>);

  // The ORM joins where statements without brackets, so a scope that ORs would swallow the filter after it
  // (`a OR b AND (filter)`). Its where statements move into one group; HAVING statements stay at the top level.
  const added = statements.splice(before);
  const isAggregate = (statement: IQueryStatement) => (statement as { IsAggregate?: boolean }).IsAggregate === true;
  const conditions = added.filter((statement) => !isAggregate(statement));
  if (conditions.length > 0) {
    query.where(function (this: IWhereBuilder<unknown>) {
      (this as unknown as Statements)._statements.push(...conditions);
    });
  }
  statements.push(...added.filter(isAggregate));
}

function answeredColumns(descriptor: IModelDescriptor, columns: readonly string[]): Set<string> {
  for (const name of columns) {
    const column = descriptor.Columns.find((c) => c.Name === name);
    if (!column || column.Virtual) {
      throw new InvalidOption(`readList over ${descriptor.Name}: options.columns names ${JSON.stringify(name)}, which is no column of its table`);
    }
  }
  return new Set([...descriptor.PrimaryKey, ...columns]);
}

function refuseHiddenFilters(entries: IFilterEntry[] | undefined, answered: ReadonlySet<string>): void {
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') {
      continue; // filter() refuses it with its own message
    }
    if (isFilterGroup(entry)) {
      refuseHiddenFilters(entry.filters, answered);
      continue;
    }
    if (typeof entry.Column === 'string' && !answered.has(entry.Column)) {
      throw new InvalidArgument(`Column '${entry.Column}' is not answered by this list, so it cannot be filtered on`, entry.Column);
    }
  }
}

function visibleAggregateColumns(columns: IAggregateColumns, answered: ReadonlySet<string>): IAggregateColumns {
  return {
    groupable: columns.groupable.filter((column) => answered.has(column)),
    aggregatable: Object.fromEntries(Object.entries(columns.aggregatable).filter(([column]) => answered.has(column))),
  };
}

function wantsNoRows(pagination: unknown): boolean {
  const limit = (pagination as { limit?: unknown } | undefined | null)?.limit;
  return limit === 0 || limit === '0';
}

function buildPage(model: typeof ModelBase, query: Query, request: IListRequest, options: IListOptions, answered: ReadonlySet<string> | undefined): Query {
  const descriptor = model.getModelDescriptor();
  const fallback = options.fallbackSort ?? { column: descriptor.PrimaryKey[0], order: SortOrder.ASC };
  if (!fallback.column) {
    throw new InvalidOption(`readList over ${descriptor.Name}: the model has no primary key, give options.fallbackSort`);
  }
  const sortable = [...new Set([...model.sortableColumns().filter((column) => !answered || answered.has(column)), fallback.column])];
  const { limit, offset } = readPage(request.pagination, options);

  for (const column of answered ?? []) {
    query.select(column);
  }
  if (request.include && request.include.length > 0) {
    query.populate(request.include);
  }
  for (const sort of readSorting(request.sorting, sortable, fallback, options)) {
    query.order(sort.column, sort.order);
  }
  return query.take(limit).skip(offset);
}

/**
 * One page of `model`, filtered, sorted and counted in SQL, with the aggregates of the same filter when asked;
 * under `options.scope` all three describe the scoped rows only.
 */
export async function readList<M extends typeof ModelBase>(model: M, request: IListRequest = {}, options: IListOptions = {}): Promise<IListAnswer<Record<string, unknown>>> {
  const descriptor = model.getModelDescriptor();
  const answered = options.columns ? answeredColumns(descriptor, options.columns) : undefined;

  if (answered) {
    refuseHiddenFilters(request.filter?.filters, answered);
    if (request.include && request.include.length > 0) {
      throw new InvalidArgument('include cannot be combined with a column projection: a relation answers columns the projection does not govern', 'include');
    }
  }

  const filtered = (): Query => {
    const query = model.query() as Query;
    applyScope(query, options.scope);
    return query.filter(request.filter?.filters, request.filter?.op);
  };

  // Every statement is built before the first one runs, so a refused request runs none.
  const count = filtered();
  const page = wantsNoRows(request.pagination) ? undefined : buildPage(model, filtered(), request, options, answered);
  const aggregates = request.aggregate ? filtered().aggregate(request.aggregate, answered ? visibleAggregateColumns(model.aggregateColumns(), answered) : undefined) : undefined;

  checkSignal(options.signal);
  const total = await count.selectCount();

  let rows: Record<string, unknown>[] = [];
  if (page) {
    checkSignal(options.signal);
    const models = (await page) as ModelBase[];
    // Omitted rather than picked afterwards: the dehydrator refuses a non-null column the projection did not select.
    const hidden = answered ? descriptor.Columns.map((c) => c.Name).filter((name) => !answered.has(name)) : undefined;
    rows = models.map((row) => (request.include?.length ? row.dehydrateWithRelations() : row.dehydrate(hidden ? { omit: hidden } : undefined)) as Record<string, unknown>);
  }

  if (!aggregates || !request.aggregate) {
    return { rows, total };
  }

  checkSignal(options.signal);
  const raw = await aggregates.asRaw<Record<string, unknown>[]>();
  return { rows, total, aggregates: readAggregateRows(raw, request.aggregate) };
}
