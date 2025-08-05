import { IColumnFilter, IFilter, IFilterRequest, FilterableLogicalOperators } from './interfaces.js';

declare module '@spinajs/orm' {
  export interface IModelDescriptor {
    /**
     * If set column is fitlerable by this operators
     */
    FilterableColumns?: Map<string, IColumnFilter<unknown>>;
  }

  export interface ISelectQueryBuilder {
    /**
     *
     * Add filter to query
     *
     * @param filter
     * @param logicalOperator
     */
    filter(filter: IFilter[], logicalOperator?: FilterableLogicalOperators, filters?: IColumnFilter<unknown>[]): this;
  }

  namespace ModelBase {
    // TODO: maybe proper return type
    /**
     * @returns json schema of filterable columns
     */
    export function filterSchema(): any;

    export function filterColumns(): IColumnFilter<unknown>[];

    /**
     *
     * NOTE: this is not a part of orm, but a part of orm-http extension
     * NOTE 2: explicit type for generic T is not possible due to typescript limitations
     *         we cannot infer type of T from function arguments couse this is augumentation
     *
     * @param filterRequest
     */
    export function filter<T extends ModelBase<unknown>>(filterRequest: IFilterRequest): Promise<Array<T>>;
  }
}
