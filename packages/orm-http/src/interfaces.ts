import { Class } from '@spinajs/di';
import { ModelBase, SelectQueryBuilder, SortOrder, WhereFunction } from '@spinajs/orm';
import { Schema } from '@spinajs/validation';

@Schema('http://json-schema.org/draft-07/schema#')
export class JsonApiIncomingObject {
  public data: {
    type: string;
    id: string;
    attributes: any;
    relationships: any;
  } = null;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

export interface ITransformOptions {
  totalCount?: number;
  currentPage?: number;
  order?: SortOrder;
  orderBy?: string;
  perPage?: number;
  model: Class<ModelBase<unknown>>;
}

export interface IColumnFilter<T> {
  column?: string;
  operators: FilterableOperators[];
  query?: (operator: FilterableOperators, value: any) => WhereFunction<T>;
}

export interface IFilter {
  Column: string;
  Operator: FilterableOperators;
  Value: any;
}


export interface IFilterRequest {
  op: FilterableLogicalOperators;
  filters: IFilter[];
}

export enum FilterableLogicalOperators {
  And = 'and',
  Or = 'or',
}

export interface FromModelOptions<T extends ModelBase> {
  /**
   * Optiona route/param/body field for primary key
   * If not set , route param is used
   */
  paramField?: string;

  /**
   * Optional field for db quuery search
   */
  queryField?: string;

  /**
   * From where to get primary key value
   * Eg. body, query, param, header etc.
   *
   * If not set, param is used
   */
  paramType?: string;

  /**
   * Sometimes we want to skip include relations eg. when we dont want to
   * load relations when getting another model in route
   */
  noInclude?: boolean;

  /**
   *
   * Callback on query builder before model is fetched from DB
   *
   * It allows to modify query with data passed to route.
   * If not set it check for include, model owner ( if has @BelongsTo field marked) etc.
   *
   * @param this
   * @param routeParams passed route params to query
   * @returns
   */
  query?: (this: SelectQueryBuilder<T>, routeParams: any, value: any) => SelectQueryBuilder;
}

export type FilterableOperators = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'nin' | 'between' | 'isnull' | 'notnull' | 'notbetween' | 'b-like' | 'e-like' | 'exists' | 'n-exists' | 'regexp';
