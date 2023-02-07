import { IModelDescriptor, IModelStatic, IOrmRelation, IRelationDescriptor, ISelectQueryBuilder, IUpdateResult, ModelBase, MODEL_DESCTRIPTION_SYMBOL, Orm, OrmException, RawQuery, Relation, RelationType, SelectQueryBuilder, SortOrder } from '@spinajs/orm';
import { BaseController, Get, BasePath, Ok, Post, Query, Del, Body, Put, PKey, ParameterType, NotFound, Policy, BodyField, Param } from '@spinajs/http';
import { Resource, Permission } from '@spinajs/rbac-http';
import { Autoinject, Constructor } from '@spinajs/di';
import { ClassInfo } from '@spinajs/reflection';
import { ResourceNotFound } from '@spinajs/exceptions';

import _ from 'lodash';
import { ModelType } from '../route-args/ModelType.js';
import { FindModelType } from '../policies/FindModelType.js';
import { QueryArgs } from '../dto/QueryArgs.js';
import { QueryFilter } from '../dto/QueryFilter.js';
import { CollectionApiTransformer } from '../interfaces.js';
import { AutoinjectService } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { QueryIncludes } from '../dto/QueryIncludes.js';

function applyIncludes(query: ISelectQueryBuilder<unknown>, includes: QueryIncludes) {
  for (const i in includes) {
    query.populate(i, function () {
      applyIncludes(this, includes[i]);
    })
  }
}

@BasePath('collection')
@Resource('repository')
@Policy(FindModelType)
export class Collections extends BaseController {

  @Logger('orm-http:api')
  protected Log: Log;

  @AutoinjectService("api.endpoint.transformer")
  protected DataTransformer: CollectionApiTransformer;

  @Autoinject()
  protected Orm: Orm;

  // --------------------- DELETE functions --------------------- //

  @Del(':model/:id')
  @Permission('deleteAny')
  public async del(@ModelType() model: IModelStatic, @Query() id: any) {
    const descriptor = this.getModelDescriptor(model);
    const result = await model.destroy(id);

    this.log.trace(`Deleted ${result.RowsAffected} records from ${descriptor.Name} with id ${id}`);

    return new Ok({
      [descriptor.PrimaryKey]: [id]
    });
  }

  @Del(':model/:id/:relation/:relationId')
  @Permission('deleteAny')
  public async deleteRelation(@ModelType() model: IModelStatic, @PKey(ParameterType.FromQuery) id: any, @Query() relation: string, @PKey(ParameterType.FromQuery) relationId: number) {

    const descriptor = this.getRelationDescriptor(model, relation);
    const tModel = this.getModelDescriptor(descriptor.TargetModel);

    const exists = await model.exists(id);
    if (!exists) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      });
    }

    const result = await descriptor.TargetModel.destroy(relationId).where(
      { [descriptor.ForeignKey]: id }
    );

    this.log.trace(`Deleted related ${result.RowsAffected} records from ${tModel.Name} with id ${id}`);

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

    const dIds = (await descriptor.TargetModel.where({
      [descriptor.ForeignKey]: id
    }).clearColumns().select(RawQuery.create(`${tModel.PrimaryKey} as id`))) as any as number[];

    const result = await descriptor.TargetModel.destroy().where({
      [descriptor.ForeignKey]: id
    });

    this.log.trace(`Deleted related ${result.RowsAffected} records from ${tModel.Name} with id ${id}`);

    return new Ok({
      [tModel.PrimaryKey]: dIds,
    });
  }

  @Post(':model/:id/:relation/:relatioName\:deleteBatch')
  @Permission('deleteAny')
  public async deleteRelationBatch(@ModelType() model: IModelStatic, @Query() id: any, @Query() relation: string, @Body() relationIds: any[]) {
    const descriptor = this.getRelationDescriptor(model, relation);
    const tModel = this.getModelDescriptor(descriptor.TargetModel);

    const exists = await model.exists(id);
    if (!exists) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      });
    }

    const result = await descriptor.TargetModel.destroy().whereIn(tModel.PrimaryKey, relationIds).where({
      [descriptor.ForeignKey]: id
    });

    this.log.trace(`Deleted ${result.RowsAffected} records from ${descriptor.Name} with id ${id}`);

    return new Ok({
      [tModel.PrimaryKey]: relationIds,
    });
  }

  @Post(':model\:batchDelete')
  public async batchDelete(@ModelType() model: IModelStatic, @Body() ids: any[]) {

    const tModel = this.getModelDescriptor(model);
    const result = await model.destroy().whereIn(tModel.PrimaryKey, ids);

    this.log.trace(`Deleted ${result.RowsAffected} records from ${tModel.Name}`);

    return new Ok({
      [tModel.PrimaryKey]: ids,
    });
  }

  // --------------------- GET functions --------------------- //

  protected applyFilters(query: SelectQueryBuilder, filters: any) {
    for (const f in filters) {
      const val = filters[f];
      if (Array.isArray(filters[f])) {
        query.whereIn(f, val);
        continue;
      }

      query.where(f, val);
    }
  }

  @Get(':model')
  @Permission('readAny')
  public async getAll(@ModelType() model: IModelStatic, @Query() getParams: QueryArgs, @Query() filters: QueryFilter, @Query() includes: QueryIncludes) {
    const query = model.where(filters);
    const cQuery = query.clone();

    applyIncludes(query, includes);

    cQuery.clearColumns()
      .select(RawQuery.create('count(*) as count'));

    if (getParams.order) {
      query.order(getParams.order, getParams.orderDirection ?? SortOrder.ASC);
    }

    if (getParams.page) {
      query.skip(getParams.page * getParams.perPage ?? 10).take(getParams.perPage ?? 10);
    }

    const result = await query;
    const count = (await cQuery.asRaw()) as { count: number }[];

    return new Ok({
      Data: result,
      Total: count[0].count,
    });


  }

  @Get(':model/:id')
  @Permission('readAny')
  public async get(@ModelType() model: IModelStatic, @Param() id: number, @Query() includes: QueryIncludes) {
    const descriptor = this.getModelDescriptor(model);
    const query = model.where({
      [descriptor.PrimaryKey]: id,
    });

    applyIncludes(query, includes);

    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [descriptor.PrimaryKey]: id,
      }),
    );

    return new Ok(result);
  }

  @Get(':model/:id/relation/:relationId')
  @Permission('readAny')
  public async getRelation(@ModelType() model: IModelStatic, @Query() id: any, @Query() relation: string, @Query() relationId: any, @Query() includes: QueryIncludes) {
    const descriptor = this.getRelationDescriptor(model, relation);
    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      }),
    );

    return new Ok((result as any)[relation]);
  }

  @Get(':model/:id/:relation')
  @Permission('readAny')
  public async getRelations(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Param() id: any, @Param() relation: string, @Param() relationId: any, @Query() params: QueryArgs, @Query() filters: QueryFilter) {
    const self = this;
    let cQuery = null;
    const { relation: dRelation, query } = this.prepareQuery(model, relation, id, function () {
      this.where(dRelation.ForeignKey, relationId);
      self.applyFilters(this, filters);

      cQuery = this.clone().select(RawQuery.create('count(*) as count'));

      if (params.order) {
        this.order(params.order, params.orderDirection ?? SortOrder.ASC);
      }

      if (params.page) {
        this.skip(params.page * params.perPage ?? 10).take(params.perPage ?? 10);
      }
    });

    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      }),
    );
    const count = (await (cQuery as SelectQueryBuilder).asRaw()) as { count: number }[];

    return new Ok({
      Data: (result as any)[relation],
      Total: count[0].count,
    });
  }

  // --------------------- POST functions --------------------- //

  @Post(':model')
  @Permission('createAny')
  public async save(@ModelType() model: IModelStatic, @BodyField() data: unknown) {
    let toInsert: ModelBase<unknown>[] = [];
    if (Array.isArray(data)) {
      toInsert = data.map((x) => new model(x));
    } else {
      toInsert = [new model(data)];
    }

    await model.insert(data);
    return new Ok(toInsert.map((x) => x.toJSON()));
  }

  @Post(':model/:id/relation/:relation')
  @Permission('createAny')
  public async insertRelation(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Param() id: any, @Param() relation: string, @BodyField() data: unknown) {
    const { query } = this.prepareQuery(model, relation, id, null);
    const toInsert = model.type['create'](data) as ModelBase<any>;

    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      }),
    );

    result.attach(toInsert);
    await toInsert.insert();

    return new Ok(toInsert.toJSON());
  }

  @Post(':model/:id/relation/:relation:bulkInsert')
  @Permission('createAny')
  public async insertRelationBulk(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Param() id: any, @Param() relation: string, @BodyField() data: unknown[]) {
    const { query } = this.prepareQuery(model, relation, id, null);
    const toInsert = data.map((x) => model.type['create'](x) as ModelBase<any>);

    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      }),
    );

    toInsert.forEach((x) => result.attach(x));
    await model.type['insert'](toInsert);

    return new Ok(toInsert.map((x) => x.toJSON()));
  }

  // --------------------- PUT functions --------------------- //

  @Put(':model/:id')
  @Permission('updateAny')
  public async update(@ModelType() model: IModelStatic, @Param() id: number, @BodyField() data: unknown) {
    const descriptor = this.getModelDescriptor(model);
    const entity = await model.where(descriptor.PrimaryKey, id).firstOrThrow(new ResourceNotFound(`Record with id ${id} not found`, {
      Resource: model.name,
      [descriptor.PrimaryKey]: id,
    }));

    entity.hydrate(data);
    await entity.update();

    this.Log.trace('Updated entity with id ${id}');

    return new Ok(entity.toJSON());
  }

  @Put(':model/:id/relation/:relationId')
  @Permission('updateAny')
  public async updateRelation(@ModelType() model: IModelStatic, @Param() id: number, @Param() relation: string, @Param() relationId: any, @BodyField() data: unknown) {

    const dModel = this.getModelDescriptor(model);
    const dRelation = this.getRelationDescriptor(model, relation);
    const dTargetModel = this.getModelDescriptor(dRelation.TargetModel);
    const entity = await model.where(id).populate(relation, function () {
      this.where(dTargetModel.PrimaryKey, relationId);
    }).firstOrThrow(new ResourceNotFound(`Record with id ${id} not found`, {
      Resource: model.name,
      [dModel.PrimaryKey]: id,
    }));

    const rEntity: ModelBase<unknown> = dRelation.Type === RelationType.One ? (entity as any)[relation].Value : (entity as any)[relation][0];

    this.Log.trace(`Updating relation ${relation} with id ${relationId} for model ${model.name} with id ${id}`);

    rEntity.hydrate(data);
    await rEntity.update();

    return new Ok(rEntity.toJSON());
  }

  // --------------------- HELPERS  functions --------------------- //


  protected getModelDescriptor(model: IModelStatic): IModelDescriptor {
    const descriptor = (model as any)[MODEL_DESCTRIPTION_SYMBOL] as IModelDescriptor;

    if (!descriptor) {
      throw new OrmException(`Model ${(model as any).name} has no descriptor`);
    }

    return descriptor;
  }

  protected getRelationDescriptor(model: IModelStatic, relation: string) {
    const descriptor = this.getModelDescriptor(model);

    if (!descriptor.Relations.has(relation)) {
      throw new OrmException(`Model ${(model as any).name} has no relation ${relation}`);
    }

    return descriptor.Relations.get(relation);
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
