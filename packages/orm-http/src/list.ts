import { ModelBase, SortOrder } from '@spinajs/orm';
import './builders.js';
import { readAggregateRows } from './aggregate.js';
import { IAggregateRequest, IFilterRequest } from './interfaces.js';
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
  /** The last sort, which keeps pages from overlapping. Default: the primary key ascending. */
  fallbackSort?: { column: string; order?: SortOrder };
}

export interface IListAnswer<T> {
  rows: T[];
  total: number;
  aggregates?: Record<string, unknown>[];
}

function wantsNoRows(pagination: unknown): boolean {
  const limit = (pagination as { limit?: unknown } | undefined | null)?.limit;
  return limit === 0 || limit === '0';
}

/** One page of `model`, filtered, sorted and counted in SQL, with the aggregates of the same filter when asked. */
export async function readList<M extends typeof ModelBase>(model: M, request: IListRequest = {}, options: IListOptions = {}): Promise<IListAnswer<Record<string, unknown>>> {
  const filtered = () => model.query().filter(request.filter?.filters, request.filter?.op);

  const total = await filtered().selectCount();

  let rows: Record<string, unknown>[] = [];
  if (!wantsNoRows(request.pagination)) {
    const fallback = options.fallbackSort ?? { column: model.getModelDescriptor().PrimaryKey[0], order: SortOrder.ASC };
    const sortable = [...new Set([...model.sortableColumns(), fallback.column])];
    const { limit, offset } = readPage(request.pagination, options);

    const query = filtered();
    const include = request.include ?? [];
    if (include.length > 0) {
      query.populate(include);
    }
    for (const sort of readSorting(request.sorting, sortable, fallback, options)) {
      query.order(sort.column, sort.order);
    }
    const models: ModelBase[] = await query.take(limit).skip(offset);
    rows = models.map((row) => (include.length > 0 ? row.dehydrateWithRelations() : row.dehydrate()) as Record<string, unknown>);
  }

  if (!request.aggregate) {
    return { rows, total };
  }

  const raw = await filtered().aggregate(request.aggregate).asRaw<Record<string, unknown>[]>();
  return { rows, total, aggregates: readAggregateRows(raw, request.aggregate) };
}
