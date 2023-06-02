import { Class } from '@spinajs/di';
import { ModelBase, SortOrder, IModelStatic, IOrmRelation, SelectQueryBuilder } from '@spinajs/orm';
import { Schema } from '@spinajs/validation';
import { BaseController } from '@spinajs/http';

import _ from 'lodash';

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
  val: string;
  op?: string;
}

/**
 * Data collection transformer. Used to transform collection of models to specific api format eg. json api
 * By default transforms to simple json representation
 */
export abstract class CollectionApiTransformer {
  public abstract transform(data: ModelBase<unknown>[] | ModelBase<unknown>, options?: ITransformOptions): unknown;
}


/**
 * Base class for crud operations. Provides helper functions
 */
export abstract class Crud extends BaseController {
  protected prepareQuery(model: IModelStatic, relation: string, id: any, callback: (this: SelectQueryBuilder<SelectQueryBuilder<any>>, relation: IOrmRelation) => void) {
    const descriptor = this.getModelDescriptor(model);
    const rDescriptor = this.getRelationDescriptor(model, relation);
    const tDescriptor = this.getModelDescriptor(rDescriptor.TargetModel);
    const sQuery = model.query().where(descriptor.PrimaryKey, id).populate(relation, callback);

    return {
      relation: rDescriptor,
      relationModel: tDescriptor,
      query: sQuery,
    };
  }
}
