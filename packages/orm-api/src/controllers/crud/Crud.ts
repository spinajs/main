import { IModelStatic, IOrmRelation, SelectQueryBuilder } from '@spinajs/orm';
import { BaseController } from '@spinajs/http';

import _ from 'lodash';

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
