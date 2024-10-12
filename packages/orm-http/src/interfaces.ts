import { Class } from '@spinajs/di';
import { ModelBase, SelectQueryBuilder, SortOrder } from '@spinajs/orm';
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

export interface IColumnFilter {
  column: string;
  operators: FilterableOperators[];
}

export interface IFilter {
  Column: string;
  Operator: FilterableOperators;
  Value: any;
}


export interface FromModelOptions<T extends ModelBase> {
  /**
   * Optiona route/param/body field for primary key
   * If not set , model primary key is used
   */
  field?: string;

  /**
   * From where to get primary key value
   * Eg. body, query, param, header etc.
   *
   * If not set, param is used
   */
  paramType?: string;

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
  query?: (this: SelectQueryBuilder<T>, routeParams: any) => SelectQueryBuilder;
}

export type FilterableOperators = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'nin' | 'between' | 'isnull' | 'notnull' | 'notbetween';
