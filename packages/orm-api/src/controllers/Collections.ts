import { IModelDescriptor, IModelStatic, IOrmRelation, MODEL_DESCTRIPTION_SYMBOL, Orm, OrmException, RelationType, SelectQueryBuilder, SortOrder } from '@spinajs/orm';
import { BaseController, Get, BasePath, Ok, Post, Query, Del, Body, Put, PKey, ParameterType, Policy, BodyField, Param } from '@spinajs/http';
import { Resource, Permission } from '@spinajs/rbac-http';
import { Autoinject } from '@spinajs/di';
import { BadRequest, ResourceNotFound } from '@spinajs/exceptions';

import _ from 'lodash';
import { ModelType } from '../route-args/ModelType.js';
import { FindModelType } from '../policies/FindModelType.js';
import { QueryArgs } from '../dto/QueryArgs.js';
import { QueryFilter } from '../dto/QueryFilter.js';
import { AutoinjectService } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { QueryIncludes } from '../dto/QueryIncludes.js';
import { CollectionApiTransformer } from './../interfaces.js';

@BasePath('collection')
@Resource('repository')
@Policy(FindModelType)
export class Collections extends BaseController {
  @Logger('orm-http:api')
  protected Log: Log;

  @AutoinjectService('api.endpoint.transformer')
  protected DataTransformer: CollectionApiTransformer;

  @Autoinject()
  protected Orm: Orm;

  // --------------------- DELETE functions --------------------- //

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
  @Permission('deleteAny')
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
  @Permission('deleteAny')
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

  // --------------------- GET functions --------------------- //

  

  // --------------------- POST functions --------------------- //

  @Post(':model')
  @Permission('createAny')
  public async save(@ModelType() model: IModelStatic, @BodyField() data: unknown) {
    const toInsert = (Array.isArray(data) ? data : [data]).map((x) => new model(x));
    await model.insert(toInsert);
    return new Ok(toInsert.map((x) => x.dehydrate()));
  }

  @Post(':model/:id/:relation')
  @Permission('createAny')
  public async insertRelation(@ModelType() model: IModelStatic, @Param() id: any, @Param() relation: string, @BodyField() data: unknown) {
    const mDescriptor = this.getModelDescriptor(model);
    const rDescriptor = this.getRelationDescriptor(model, relation);

    const m = await model.get(id);
    if (!m) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [mDescriptor.PrimaryKey]: id,
      });
    }

    const toInsert = (Array.isArray(data) ? data : [data]).map((x) => new rDescriptor.TargetModel(x));
    toInsert.forEach((x) => {
      m.attach(x);
    });

    await rDescriptor.TargetModel.insert(toInsert);

    return new Ok(toInsert.map((x) => x.dehydrate()));
  }

  // --------------------- PUT functions --------------------- //

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

  // --------------------- HELPERS  functions --------------------- //

  
}
