import { IModelStatic, Orm } from '@spinajs/orm';
import { BasePath, Ok, Put, Policy, BodyField, Param } from '@spinajs/http';
import { Permission } from '@spinajs/rbac-http';
import { Autoinject } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

import _ from 'lodash';
import { ModelType } from '../../route-args/ModelType.js';
import { FindModelType } from '../../policies/FindModelType.js';
import { Log, Logger } from '@spinajs/log';
import { AccessControl } from '@spinajs/rbac';
import { Crud } from './Crud.js';

@BasePath('crud')
@Policy(FindModelType)
export class CrudUpdate extends Crud {
  @Logger('orm-http:api')
  protected Log: Log;

  @Autoinject()
  protected Orm: Orm;

  @Autoinject()
  protected Ac: AccessControl;

  @Put(':model/:id')
  @Permission('updateAny')
  public async update(@ModelType() model: IModelStatic, @Param() id: number, @BodyField() data: unknown) {
    const descriptor = this.getModelDescriptor(model);
    const entity = await model.where(descriptor.PrimaryKey, id).firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [descriptor.PrimaryKey]: id,
      }),
    );

    entity.hydrate(data);
    await entity.update();

    this.Log.trace('Updated entity with id ${id}');

    return new Ok(entity.toJSON());
  }

  @Put(':model/:id/:relation/:relationId')
  @Permission('updateAny')
  public async updateRelation(@ModelType() model: IModelStatic, @Param() id: number, @Param() relation: string, @Param() relationId: any, @BodyField() data: unknown) {
    const mDescriptor = this.getModelDescriptor(model);
    const rDescriptor = this.getRelationDescriptor(model, relation);
    const rmDescriptor = this.getModelDescriptor(rDescriptor.TargetModel);
    const query = rDescriptor.TargetModel.query();

    const pExists = await model.exists(id);
    if (!pExists) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [mDescriptor.PrimaryKey]: id,
      });
    }

    const result = await query.where(rmDescriptor.PrimaryKey, relationId).firstOrThrow(
      new ResourceNotFound(`Record with id ${relationId} not found`, {
        Resource: rDescriptor.TargetModel.name,
        [rmDescriptor.PrimaryKey]: relationId,
      }),
    );

    this.Log.trace(`Updating relation ${relation} with id ${relationId} for model ${model.name} with id ${id}`);

    result.hydrate(data);
    await result.update();

    return new Ok(result.toJSON());
  }
}
