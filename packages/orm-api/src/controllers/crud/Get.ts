import { IModelStatic, Orm, SortOrder } from '@spinajs/orm';
import { Get, Ok, Query, Param, Policy, BasePath } from '@spinajs/http';
import { Permission, Resource } from '@spinajs/rbac-http';
import { Autoinject } from '@spinajs/di';
import { ResourceNotFound } from '@spinajs/exceptions';

import _ from 'lodash';
import { ModelType } from '../../route-args/ModelType.js';
import { QueryArgs } from '../../dto/QueryArgs.js';
import { QueryFilter } from '../../dto/QueryFilter.js';
import { Log, Logger } from '@spinajs/log';
import { QueryIncludes } from '../../dto/QueryIncludes.js';
import { Crud } from './Crud.js';
import { FindModelType } from '../../policies/FindModelType.js';

@BasePath('crud')
@Policy(FindModelType)
export class CrudGet extends Crud {
  @Logger('orm-http:api')
  protected Log: Log;

  @Autoinject()
  protected Orm: Orm;

  @Get(':model')
  public async getAll(@ModelType() model: IModelStatic, @Query() getParams: QueryArgs, @Query() filters: QueryFilter, @Query() includes: QueryIncludes) {
    const query = model
      .where(filters)
      .select('*')
      .populate(includes)
      .order(getParams.order, getParams.orderDirection ?? SortOrder.ASC)
      .skip(getParams.page * getParams.perPage ?? 0)
      .take(getParams.perPage ?? 10);
    const count = await query.clone().clearColumns().count('*', 'count').takeFirst().asRaw<{ count: number }>();
    const result = await query;

    return new Ok({
      Data: result.map((x) => x.dehydrateWithRelations()),
      Total: count.count,
    });
  }

  @Get(':model/:id')
  public async get(@ModelType() model: IModelStatic, @Param() id: number, @Query() includes: QueryIncludes) {
    const descriptor = this.getModelDescriptor(model);
    const result = await model
      .query()
      .select('*')
      .where(descriptor.PrimaryKey, id)
      .populate(includes)
      .firstOrThrow(
        new ResourceNotFound(`Record with id ${id} not found`, {
          Resource: model.name,
          [descriptor.PrimaryKey]: id,
        }),
      );

    return new Ok(result.dehydrateWithRelations());
  }

  @Get(':model/:id/:relation/:relationId')
  public async getRelation(@ModelType() model: IModelStatic, @Param() id: any, @Param() relation: string, @Param() relationId: any, @Query() includes: QueryIncludes) {
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

    const result = await query
      .select('*')
      .populate(includes)
      .where(rmDescriptor.PrimaryKey, relationId)
      .firstOrThrow(
        new ResourceNotFound(`Record with id ${relationId} not found`, {
          Resource: rDescriptor.TargetModel.name,
          [rmDescriptor.PrimaryKey]: relationId,
        }),
      );

    return new Ok(result.dehydrateWithRelations());
  }

  @Get(':model/:id/:relation')
  public async getRelations(@ModelType() model: IModelStatic, @Param() id: any, @Param() relation: string, @Query() params: QueryArgs, @Query() filters: QueryFilter, @Query() includes: QueryIncludes) {
    const mDescriptor = this.getModelDescriptor(model);
    const rDescriptor = this.getRelationDescriptor(model, relation);

    const pExists = await model.exists(id);
    if (!pExists) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [mDescriptor.PrimaryKey]: id,
      });
    }

    const query = rDescriptor.TargetModel.where(filters)
      .where(rDescriptor.ForeignKey, id)
      .select('*')
      .populate(includes)
      .order(params.order, params.orderDirection ?? SortOrder.ASC)
      .skip(params.page * params.perPage ?? 0)
      .take(params.perPage ?? 10);
    const count = await query.clone().clearColumns().count('*', 'count').takeFirst().asRaw<{ count: number }>();
    const result = await query;

    return new Ok({
      Data: result.map((x) => x.dehydrateWithRelations()),
      Total: count,
    });
  }
}
