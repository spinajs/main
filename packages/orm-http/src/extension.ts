import { AggregateFunction, IAggregateColumns, IAggregateRequest, IColumnFilter, IFilterEntry, IFilterRequest, FilterableLogicalOperators } from './interfaces.js';

declare module '@spinajs/orm' {
  export interface IModelDescriptor {
    /**
     * If set column is fitlerable by this operators
     */
    FilterableColumns?: Map<string, IColumnFilter<unknown>>;

    /** Columns a list may be sorted by; absent means the filterable table columns. */
    SortableColumns?: Set<string>;

    GroupableColumns?: Set<string>;

    AggregatableColumns?: Map<string, AggregateFunction[]>;

    /** Relations a request may load through `include`; absent means the model does not restrict `@FromModel`. */
    IncludableRelations?: Set<string>;
  }

  export interface ISelectQueryBuilder {
    /**
     *
     * Add filter to query
     *
     * Passing no filters (undefined / null / empty array) is a no-op, so routes
     * with an optional filter param can call this unconditionally.
     *
     * @param filter
     * @param logicalOperator
     */
    filter(filter?: IFilterEntry[] | null, logicalOperator?: FilterableLogicalOperators, filters?: IColumnFilter<unknown>[]): this;

    /**
     * Replaces the selected columns with the group columns and measures of `spec`, groups, orders and
     * limits. Read the rows with `asRaw()` and pass them through `readAggregateRows`.
     */
    aggregate(spec: IAggregateRequest, columns?: IAggregateColumns): this;
  }

  namespace ModelBase {
    // TODO: maybe proper return type
    /**
     * @returns json schema of filterable columns
     */
    export function filterSchema(): any;

    export function filterColumns(): IColumnFilter<unknown>[];

    /** Columns a request may sort a list of this model by. */
    export function sortableColumns(): string[];

    export function aggregateColumns(): IAggregateColumns;

    /** @returns json schema of an aggregate request over this model */
    export function aggregateSchema(): object;

    export function includableRelations(): string[];

    /**
     *
     * NOTE: this is not a part of orm, but a part of orm-http extension
     * NOTE 2: explicit type for generic T is not possible due to typescript limitations
     *         we cannot infer type of T from function arguments couse this is augumentation
     *
     * @param filterRequest
     */
    export function filter<T extends ModelBase<unknown>>(filterRequest?: IFilterRequest): Promise<Array<T>>;
  }
}
