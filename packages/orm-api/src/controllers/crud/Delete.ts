import { IModelStatic, Orm, RelationType } from '@spinajs/orm';
import { BasePath, Ok, Post, Query, Del, Body, PKey, ParameterType, Policy, Param } from '@spinajs/http';
import { Permission } from '@spinajs/rbac-http';
import { Autoinject } from '@spinajs/di';
import { BadRequest, ResourceNotFound } from '@spinajs/exceptions';

import _ from 'lodash';
import { ModelType } from '../../route-args/ModelType.js';
import { FindModelType } from '../../policies/FindModelType.js';
import { Log, Logger } from '@spinajs/log';
import { AccessControl } from '@spinajs/rbac';
import { Crud } from './../../interfaces.js';

@BasePath('crud')
@Policy(FindModelType)
export class CrudDelete extends Crud {
  @Logger('orm-http:api')
  protected Log: Log;

  @Autoinject()
  protected Orm: Orm;

  @Autoinject()
  protected Ac: AccessControl;

  @Post(':model/__batchDelete')
  public async batchDelete(@ModelType() model: IModelStatic, @Body() ids: any[]) {
    const tModel = this.getModelDescriptor(model);
    const result = await model.destroy().whereIn(tModel.PrimaryKey, ids);

    this.Log.trace(`Deleted ${result.RowsAffected} records from ${tModel.Name}`);

    return new Ok({
      [tModel.PrimaryKey]: ids,
    });
  }

  @Del(':model/:id')
  @Permission('deleteAny')
  public async del(@ModelType() model: IModelStatic, @Param() id: any) {
    const descriptor = this.getModelDescriptor(model);
    const result = await model.destroy(id);

    this.Log.trace(`Deleted ${result.RowsAffected} records from ${descriptor.Name} with id ${id}`);

    return new Ok({
      [descriptor.PrimaryKey]: [id],
    });
  }

  @Post(':model/:id/:relation/__batchDelete')
  @Permission('deleteAny')
  public async deleteRelationBatch(@ModelType() model: IModelStatic, @Param() id: any, @Param() relation: string, @Body() relationIds: any[]) {
    const descriptor = this.getRelationDescriptor(model, relation);

    if (descriptor.Type === RelationType.One) {
      throw new BadRequest('Cannot delete batch from one to one relation');
    }

    const exists = await model.exists(id);
    if (!exists) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      });
    }

    const result = await descriptor.TargetModel.destroy(relationIds).where(descriptor.ForeignKey, id);

    this.Log.trace(`Deleted ${result.RowsAffected} records from ${descriptor.Name} with id ${id}`);

    return new Ok(relationIds);
  }

  @Del(':model/:id/:relation/:relationId')
  public async deleteRelation(@ModelType() model: IModelStatic, @Param() id: any, @Param() relation: string, @Param() relationId: number) {
    const descriptor = this.getRelationDescriptor(model, relation);
    const tModel = this.getModelDescriptor(descriptor.TargetModel);

    const exists = await model.exists(id);
    if (!exists) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      });
    }

    const result = await descriptor.TargetModel.destroy(relationId).when(descriptor.Type !== RelationType.One, function () {
      this.where({ [descriptor.ForeignKey]: id });
    });

    this.Log.trace(`Deleted related ${result.RowsAffected} records from ${tModel.Name} with id ${id}`);

    return new Ok({
      [tModel.PrimaryKey]: relationId,
    });
  }

  @Del(':model/:id/:relation')
  public async deleteRelationAll(@ModelType() model: IModelStatic, @PKey(ParameterType.FromQuery) id: any, @Query() relation: string) {
    const descriptor = this.getRelationDescriptor(model, relation);
    const tModel = this.getModelDescriptor(descriptor.TargetModel);

    const exists = await model.exists(id);
    if (!exists) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      });
    }

    const result = await descriptor.TargetModel.destroy().when(descriptor.Type !== RelationType.One, function () {
      this.where(descriptor.ForeignKey, id);
    });

    this.Log.trace(`Deleted related ${result.RowsAffected} records from ${tModel.Name} with id ${id}`);

    return new Ok();
  }
}
