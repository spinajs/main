import { IModelDescriptor, IOrmRelation, IUpdateResult, ModelBase, MODEL_DESCTRIPTION_SYMBOL, Orm, OrmException, RawQuery, RelationType, SelectQueryBuilder, SortOrder } from '@spinajs/orm';
import { BaseController, Get, BasePath, Ok, Post, Query, Del, Body, Put, PKey, ParameterType, NotFound, Policy, BodyField, Param, ArgHydrator, Hydrator } from '@spinajs/http';
import { Resource, Permission } from '@spinajs/rbac-http';
import { Autoinject } from '@spinajs/di';
import { FindModelType } from '../policies/FindModelType.js';
import { ModelType } from '../route-args/ModelTypeRouteArgs.js';
import { ClassInfo } from '@spinajs/reflection';
import { ResourceNotFound } from '@spinajs/exceptions';

import _ from 'lodash';
import { Schema } from '@spinajs/validation';

const GetSchemaDTO = {
  type: 'object',
  properties: {
    page: { type: 'number' },
    perPage: { type: 'number' },
    orderDirection: { type: 'string', enum: ['ASC', 'DESC'] },
    order: { type: 'string' },
  },
};

export class GetFilterHydrator extends ArgHydrator {
  public async hydrate(input: string): Promise<any> {
    return new GetFilter(JSON.parse(input));
  }
}

@Schema(GetSchemaDTO)
export class GetDto {
  public page?: number;
  public perPage?: number;
  public orderDirection?: SortOrder;
  public order?: string;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

@Hydrator(GetFilterHydrator)
export class GetFilter {
  [key: string]: any;

  constructor(data: any) {
    Object.assign(this, data);
  }
}

@BasePath('collection')
@Resource('repository')
@Policy(FindModelType)
export class BasicRestOrmApi extends BaseController {
  @Autoinject()
  protected Orm: Orm;

  // --------------------- DELETE functions --------------------- //

  @Del('/:model/:id')
  @Permission('deleteAny')
  public async del(@ModelType() model: ClassInfo<ModelBase<unknown>>, @PKey(ParameterType.FromQuery) id: number) {
    const result = (await model.type['delete'](id)) as IUpdateResult;
    if (result.RowsAffected === 1) {
      return new Ok({
        Id: id,
      });
    }

    return new NotFound({
      Id: id,
    });
  }

  @Del('/:model/:id/:relation/:relationId')
  @Permission('deleteAny')
  public async deleteRelation(@ModelType() model: ClassInfo<ModelBase<unknown>>, @PKey(ParameterType.FromQuery) id: any, @Query() relation: string, @PKey(ParameterType.FromQuery) relationId: number) {
    const { relation: tRelation, query } = this.prepareRelationAction(model, relation, id, function () {
      this.where(tRelation.ForeignKey, relationId);
    });

    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        Id: id,
      }),
    );

    const toDelete: ModelBase<unknown> = tRelation.Type === RelationType.One ? (result as any)[relation].Value : _.first((result as any)[relation]);
    if (toDelete) {
      await toDelete.destroy();
    }

    return new Ok({
      [toDelete.PrimaryKeyName]: toDelete.PrimaryKeyValue,
    });
  }

  @Post('/:model/:id/:relation/:relatioName:deleteBatch')
  @Permission('deleteAny')
  public async deleteRelationBatch(@ModelType() model: ClassInfo<ModelBase<unknown>>, @PKey(ParameterType.FromQuery) id: any, @Query() relatioName: string, @Body() relationIds: any[]) {
    const {
      relation: mRelation,
      query,
      relationModel,
    } = this.prepareRelationAction(model, relatioName, id, function () {
      this.whereIn(mRelation.ForeignKey, relationIds);
    });

    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [relationModel.PrimaryKey]: id,
      }),
    );

    let toDelete: ModelBase<unknown>[] = (result as any)[relatioName];
    if (toDelete.length === 0) {
      return new Ok({
        [relationModel.PrimaryKey]: [],
      });
    }

    const dResult = (await model.type['delete'](toDelete.map((x) => x.PrimaryKeyValue))) as IUpdateResult;
    if (dResult.RowsAffected !== relationIds.length) {
      this._log.trace(`Batch delete didnt delete all records in model ${model.name}, expected ${relationIds.length} rows affected, got ${dResult.RowsAffected}`);
    }

    return new Ok({
      [relationModel.PrimaryKey]: relationIds,
    });
  }

  @Post('/:model:batchDelete')
  public async batchDelete(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Body() ids: any[]) {
    const result = (await model.type['delete'](ids)) as IUpdateResult;
    if (result.RowsAffected !== ids.length) {
      this._log.trace(`Batch delete didnt delete all records in model ${model.name}, expected ${ids.length} rows affected, got ${result.RowsAffected}`);
    }

    return new Ok({
      Id: ids,
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

  @Get('/:model')
  @Permission('readAny')
  public async getAll(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Query() getParams: GetDto, @Query() filters: GetFilter) {
    const query = model.type['where'](filters) as SelectQueryBuilder;
    const cQuery = model.type['where'](filters) as SelectQueryBuilder;

    cQuery.select(RawQuery.create('count(*) as count'));

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
  public async get(@ModelType() model: ClassInfo<ModelBase<unknown>>, id: number) {
    const descriptor = this.getModelDescriptor(model);
    const query = model.type['where'](id) as SelectQueryBuilder;

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
  public async getRelation(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Query() id: any, @Query() relation: string, @Query() relationId: any) {
    const { relation: mRelation, query } = this.prepareRelationAction(model, relation, id, function () {
      this.where(mRelation.ForeignKey, relationId);
    });

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
  public async getRelations(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Param() id: any, @Param() relation: string, @Param() relationId: any, @Query() params: GetDto, @Query() filters: GetFilter) {
    const self = this;
    let cQuery = null;
    const { relation: dRelation, query } = this.prepareRelationAction(model, relation, id, function () {
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

  @Post('/:model')
  @Permission('createAny')
  public async save(@ModelType() model: ClassInfo<ModelBase<unknown>>, @BodyField() data: unknown) {
    let toInsert: ModelBase<unknown>[] = [];
    if (Array.isArray(data)) {
      toInsert = data.map((x) => model.type['create'](x));
    } else {
      toInsert = [model.type['create'](data)];
    }

    await model.type['insert'](data);
    return new Ok(toInsert.map((x) => x.toJSON()));
  }

  @Post('/:model/:id/relation/:relation')
  @Permission('createAny')
  public async insertRelation(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Param() id: any, @Param() relation: string, @BodyField() data: unknown) {
    const { query } = this.prepareRelationAction(model, relation, id, null);
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

  @Post('/:model/:id/relation/:relation:bulkInsert')
  @Permission('createAny')
  public async insertRelationBulk(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Param() id: any, @Param() relation: string, @BodyField() data: unknown[]) {
    const { query } = this.prepareRelationAction(model, relation, id, null);
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

  @Put('/:model/:id')
  @Permission('updateAny')
  public async update(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Param() id: number, @BodyField() data: unknown) {
    const descriptor = this.getModelDescriptor(model);
    const query = model.type['where'](id) as SelectQueryBuilder<ModelBase<any>>;

    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [descriptor.PrimaryKey]: id,
      }),
    );

    result.hydrate(data);
    await result.update();

    return new Ok(result.toJSON());
  }

  @Put('/:model/:id/relation/:relationId')
  @Permission('updateAny')
  public async updateRelation(@ModelType() model: ClassInfo<ModelBase<unknown>>, @Param() id: number, @Param() relation: string, @Param() relationId: any, @BodyField() data: unknown) {
    const {
      relation: dRelation,
      relationModel,
      query,
    } = this.prepareRelationAction(model, relation, id, function () {
      this.where(dRelation.ForeignKey, relationId);
    });

    const result = await query.firstOrThrow(
      new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [relationModel.PrimaryKey]: id,
      }),
    );

    result.hydrate(data);
    await result.update();

    return new Ok(result.toJSON());
  }

  // --------------------- HELPERS  functions --------------------- //

  protected getModelDescriptor(model: ClassInfo<ModelBase<unknown>>): IModelDescriptor {
    return (model.type as any)[MODEL_DESCTRIPTION_SYMBOL] as IModelDescriptor;
  }

  protected prepareRelationAction(model: ClassInfo<ModelBase<unknown>>, relation: string, id: any, callback: (this: SelectQueryBuilder<SelectQueryBuilder<any>>, relation: IOrmRelation) => void) {
    const descriptor = this.getModelDescriptor(model);
    if (!descriptor) {
      throw new OrmException(`Model ${model.type.name} has no descriptor`);
    }

    if (!descriptor.Relations.has(relation)) {
      throw new OrmException(`Model ${model.type.name} has no relation ${relation}`);
    }

    const mRelation = descriptor.Relations.get(relation);
    const tDescriptor = (mRelation.TargetModel as any)[MODEL_DESCTRIPTION_SYMBOL] as IModelDescriptor;
    const sQuery = model.type['query'] as SelectQueryBuilder<ModelBase<any>>;
    sQuery.where(descriptor.PrimaryKey, id).populate(relation, callback);

    return {
      relation: mRelation,
      relationModel: tDescriptor,
      query: sQuery,
    };
  }
}
