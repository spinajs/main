import { IModelDescriptor, IModelStatic, IOrmRelation, MODEL_DESCTRIPTION_SYMBOL, OrmException, SelectQueryBuilder } from '@spinajs/orm';
import { BaseController } from '@spinajs/http';

import _ from 'lodash';

/**
 * Base class for crud operations. Provides helper functions
 */
export abstract class Crud extends BaseController {
  protected getModelDescriptor(model: IModelStatic): IModelDescriptor {
    const descriptor = (model as any)[MODEL_DESCTRIPTION_SYMBOL] as IModelDescriptor;

    if (!descriptor) {
      throw new OrmException(`Model ${(model as any).name} has no descriptor`);
    }

    return descriptor;
  }

  protected getRelationDescriptor(model: IModelStatic, relation: string) {
    const descriptor = this.getModelDescriptor(model);
    let rDescriptor = null;
    for (const [key, value] of descriptor.Relations) {
      if (key.toLowerCase() === relation.toLowerCase().trim()) {
        rDescriptor = value;
        break;
      }
    }

    if (!rDescriptor) {
      throw new OrmException(`Model ${(model as any).name} has no relation ${relation}`);
    }

    return rDescriptor;
  }

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
