import { NewInstance } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import _ from 'lodash';
import { SortOrder } from '../enums.js';
import { RelationType } from '../interfaces.js';
import type { IOrderByBuilder, ISort } from '../interfaces.js';
import { extractModelDescriptor } from '../descriptor.js';
import type { IRelationSort } from './internal.js';
import type { SelectQueryBuilder } from './select.js';

/**
 * The sort direction a caller meant. Case is not the caller's business - `asc` off a query string
 * and `SortOrder.ASC` are one order - but anything else would reach the statement verbatim.
 */
export function sortOrderOf(order?: string | SortOrder | null): SortOrder {
  if (order === undefined || order === null) {
    return SortOrder.ASC;
  }

  const normalized = String(order).trim().toUpperCase();
  if (normalized === '') {
    return SortOrder.NONE;
  }

  if (normalized !== SortOrder.ASC && normalized !== SortOrder.DESC) {
    throw new InvalidArgument(`Invalid sort order '${order}', expected ASC or DESC`);
  }

  return normalized;
}

@NewInstance()
export class OrderByBuilder implements IOrderByBuilder {
  protected _sorts: ISort[];
  protected _orderable: string[];

  constructor() {
    this._sorts = [];
    this._orderable = [];
  }

  /**
   * Identifiers this query yields that are no columns of its model - the aliases of a raw select,
   * which nothing can read back out of the SQL. Declaring them at the point they are selected is
   * what lets {@link SelectQueryBuilder.validateSorts} keep checking a query that selects raw SQL
   * instead of waving it through.
   */
  public orderable(...columns: string[]) {
    this._orderable.push(...columns);
    return this;
  }

  public getOrderable(): string[] {
    return this._orderable;
  }

  /**
   * Appends to this query's ORDER BY. Takes a column with a direction, one sort object, or a list
   * of them - a list is how a caller expresses "what was asked for, then the fallback": an entry
   * with no column is dropped, and a column already sorted on is not repeated, so
   * `order([requested, { column: 'id', order: SortOrder.DESC }])` orders by the request when there
   * is one and by `id` either way, which is what keeps paging stable.
   *
   * `Relation.column` orders by a column of a to-one relation, which rides in this query as a
   * join. A to-many relation is fetched by a query of its own, where ordering rearranges the
   * children and leaves this result set as it was, so it is refused rather than silently ignored.
   */
  public order(column: string, direction?: SortOrder): this;
  public order(sort: Partial<ISort> | Array<Partial<ISort> | null | undefined> | null | undefined): this;
  public order(columnOrSort: string | Partial<ISort> | Array<Partial<ISort> | null | undefined> | null | undefined, direction?: SortOrder): this {
    if (Array.isArray(columnOrSort)) {
      columnOrSort.forEach((sort) => this.order(sort));
      return this;
    }

    if (!columnOrSort) {
      return this;
    }

    const sort = _.isString(columnOrSort) ? { column: columnOrSort, order: direction } : columnOrSort;
    const column = sort.column?.trim();
    const order = sortOrderOf(sort.order);

    // A column the caller did not set is not an ordering: dropped so a fallback entry can decide,
    // rather than compiled into an ORDER BY of an empty identifier.
    if (!column || order === SortOrder.NONE) {
      return this;
    }

    const separator = column.indexOf('.');
    if (separator !== -1) {
      const relation = column.slice(0, separator);
      const rest = column.slice(separator + 1);

      this._assertOrderableRelation(relation, column);

      // One hop at a time: the nested call resolves the rest against the relation's own model,
      // and its sort lands in this slot (qualified with the relation alias) when the relation
      // compiles - appended instead, it would come after any fallback ordered here meanwhile.
      const slot = Symbol(column);
      (this as any as SelectQueryBuilder).populate(relation, function (this: SelectQueryBuilder) {
        this.order({ column: rest, order, fills: slot } as Partial<ISort>);
      });
      this._sorts.push({ column: '', order, awaits: slot, fills: (sort as IRelationSort).fills } as IRelationSort);

      return this;
    }

    // `order()` appends, but the same column twice is not a second ordering - the first one
    // already decided it, and the repeat only shows up as noise in the statement.
    if (!this._sorts.some((s) => s.column === column && s.tableAlias === sort.tableAlias)) {
      this._sorts.push({ ...sort, column, order });
    }

    return this;
  }

  public orderBy(column: string) {
    return this.order(column, SortOrder.ASC);
  }

  public orderByDescending(column: string) {
    return this.order(column, SortOrder.DESC);
  }

  /**
   * Refuses `Relation.column` where the relation is not to-one. Unknown relations are left to
   * `populate()`, which names them in its own error.
   */
  protected _assertOrderableRelation(relation: string, column: string) {
    const descriptor = extractModelDescriptor((this as any as { _model: unknown })._model);
    if (!descriptor) {
      return;
    }

    // TODO: do not use toLowerCase for comparison, relations should be case sensitive
    // leave it now for backward compatibility, as populate() matches this way
    const [, rDescriptor] = [...descriptor.Relations].find(([name]) => name.toLowerCase() === relation.toLowerCase()) ?? [];
    if (rDescriptor && rDescriptor.Type !== RelationType.One) {
      throw new InvalidArgument(`Cannot order by ${column}, ${relation} is not a to-one relation - ordering it would leave this result set as it was`);
    }
  }

  /**
   * Returns the FIRST sort entry (or null) for backward compat with dialect
   * packages that emit a single ORDER BY column. Use getSorts() for all entries.
   */
  public getSort() {
    const sort = this._sorts.find((s) => s.column.trim() !== '');
    return sort ?? null;
  }

  /**
   * Returns all sort entries (multi-column ORDER BY), skipping empty columns.
   */
  public getSorts(): ISort[] {
    return this._sorts.filter((s) => s.column.trim() !== '');
  }
}
