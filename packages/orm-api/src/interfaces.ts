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

export interface IQueryFilterEntry{ 
  value: string;
  operator?: string;
}

/**
 * Data collection transformer. Used to transform collection of models to specific api format eg. json api
 * By default transforms to simple json representation
 */
export abstract class CollectionApiTransformer {
  public abstract transform(data: ModelBase<unknown>[] | ModelBase<unknown>, options?: ITransformOptions): unknown;
}