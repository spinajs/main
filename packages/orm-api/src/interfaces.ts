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
   * Sometimes we want to skip include relations eg. when we dont want to 
   * load relations when getting another model in route
   */
   noInclude? : boolean;


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

export interface IQueryFilterEntry {
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
