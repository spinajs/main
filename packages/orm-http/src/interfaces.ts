import { Class } from '@spinajs/di';
import { ModelBase, SortOrder } from '@spinajs/orm';
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

declare module '@spinajs/orm' {
  export interface IColumnDescriptor {
    /**
     * If set column is fitlerable by this operators
     */
    Filterable?: FilterableOperators[];
  }

  export interface IWhereBuildet<T> {

    /**
     * 
     * Add filter to query
     * 
     * @param filter 
     */
    filter(filter: IFilter[]): this;
  }

  export interface IModelBase {
    // TODO: maybe proper return type
    /**
     * @returns json schema of filterable columns
     */
    filterSchema(): any;

    filterColumns(): IColumFilter[];
  }
}

export interface IColumFilter {
  column: string;
  operators: FilterableOperators[];
}

export interface IFilter {
  Column: string;
  Operator: FilterableOperators;
  Value: any;
}

export type FilterableOperators = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'in' | 'nin' | 'between' | 'isnull' | 'notnull' | 'notbetween';
