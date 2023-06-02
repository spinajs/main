import { Permission } from 'accesscontrol';
import { Orm, SortOrder, IModelStatic, ISelectQueryBuilder } from '@spinajs/orm';
import { Get, Ok, Query, Param, Policy, BasePath } from '@spinajs/http';
import { User } from '@spinajs/rbac-http';
import { User as UserModel, IRbacModelDescriptor, AccessControl } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { BadRequest, Forbidden, ResourceNotFound, UnexpectedServerError } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import '@spinajs/rbac';

import _ from 'lodash';
import { ModelType } from '../../route-args/ModelType.js';
import { QueryArgs } from '../../dto/QueryArgs.js';
import { QueryFilter } from '../../dto/QueryFilter.js';
import { QueryIncludes } from '../../dto/QueryIncludes.js';
import { Crud } from './Crud.js';
import { FindModelType } from '../../policies/FindModelType.js';

@BasePath('crud')
@Policy(FindModelType)
export class CrudRead extends Crud {
  @Logger('orm-http:api')
  protected Log: Log;

  @Autoinject()
  protected Orm: Orm;

  @Autoinject()
  protected Ac: AccessControl;

  /**
   * retrieve resource name, if model does not have @OrmResource decorator set
   * model name is default resource name
   * @param model
   * @returns
   */
  protected getResourceName(model: IModelStatic) {
    const descriptor = model.getModelDescriptor() as IRbacModelDescriptor;
    return descriptor.RbacResource ? descriptor.RbacResource : descriptor.Name;
  }

  /**
   *
   * Creates query on model and ansures that user have proper permission to access it
   *
   * @param model model to query against
   * @param user user for permission check
   * @returns
   */
  protected getSafeQuery(model: IModelStatic, user: UserModel) {
    const query = model.query();

    const resource = this.getResourceName(model);
    let permission: Permission = user.canReadAny(resource);

    if (!permission.granted) {
      // permission for readAny not  granted, check for own
      permission = user.canReadOwn(resource);
      if (permission.granted) {
        if (model.ensureOwnership) {
          model.ensureOwnership(query, user);
        } else {
          throw new UnexpectedServerError(`Resource ${resource} can be only read by owner and does not have ensureOwnership method implemented`);
        }
      } else {
        throw new Forbidden(`You do not access to ${resource}`);
      }
    }

    return { query, permission };
  }

  @Get(':model')
  public async getAll(@ModelType() model: IModelStatic, @Query() getParams: QueryArgs, @Query() filters: QueryFilter, @Query() includes: QueryIncludes, @User() user: UserModel) {
    const { query, permission } = this.getSafeQuery(model, user);
    query
      .select('*')
      .populate(includes)
      .order(getParams.order, getParams.orderDirection ?? SortOrder.ASC)
      .skip(getParams.page * getParams.perPage ?? 0)
      .take(getParams.perPage ?? 10);

    // apply basic filters
    for (const filter in filters) {
      const f = filters[filter];

      // if filter have no operator, by default we assume qeuality
      query.where(filter, f.operator ? f.operator : '=', f.value);
    }

    const count = await query.clone().clearColumns().count('*', 'count').takeFirst().asRaw<{ count: number }>();
    const result = await query;

    return new Ok({
      Data: result.map((x) => x.dehydrateWithRelations()).map((x) => permission.filter(x)),
      Total: count.count,
    });
  }

  @Get(':model/:id')
  public async get(@User() user: UserModel, @ModelType() model: IModelStatic, @Param() id: number, @Query() includes: QueryIncludes) {
    const descriptor = model.getModelDescriptor();
    const { query, permission } = this.getSafeQuery(model, user);
    const result = await query
      .select('*')
      .where(descriptor.PrimaryKey, id)
      .populate(includes)
      .firstOrThrow(
        new ResourceNotFound(`Record with id ${id} not found`, {
          Resource: model.name,
          [descriptor.PrimaryKey]: id,
        }),
      );

    return new Ok(permission.filter(result.dehydrateWithRelations()));
  }

  @Get(':model/:id/:relation/:relationId')
  public async getRelation(@ModelType() model: IModelStatic, @Param() id: any, @Param() relation: string, @Param() relationId: any, @Query() includes: QueryIncludes, @User() user?: UserModel) {
    const mDescriptor = model.getModelDescriptor();
    const rDescriptor = model.getRelationDescriptor(relation);
    const rmDescriptor = rDescriptor.TargetModel.getModelDescriptor();
    const { query, permission } = this.getSafeQuery(rDescriptor.TargetModel, user);

    if (!mDescriptor.Relations.has(relation)) {
      return new BadRequest(`Resource ${mDescriptor.Name} does not have relation ${relation} defined`);
    }

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

    return new Ok(permission.filter(result.dehydrateWithRelations()));
  }

  @Get(':model/:id/:relation')
  public async getRelations(@ModelType() model: IModelStatic, @Param() id: any, @Param() relation: string, @Query() params: QueryArgs, @Query() filters: QueryFilter, @Query() includes: QueryIncludes, @User() user?: UserModel) {
    const mDescriptor = model.getModelDescriptor();
    const rDescriptor = model.getRelationDescriptor(relation);
    const { query, permission } = this.getSafeQuery(rDescriptor.TargetModel, user);

    if (!mDescriptor.Relations.has(relation)) {
      return new BadRequest(`Resource ${mDescriptor.Name} does not have relation ${relation} defined`);
    }

    const pExists = await model.exists(id);
    if (!pExists) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [mDescriptor.PrimaryKey]: id,
      });
    }

    query
      .where(rDescriptor.ForeignKey, id)
      .select('*')
      .populate(includes)
      .order(params.order, params.orderDirection ?? SortOrder.ASC)
      .skip(params.page * params.perPage ?? 0)
      .take(params.perPage ?? 10);

    // apply basic filters
    for (const filter in filters) {
      const f = filters[filter];

      // if filter have no operator, by default we assume qeuality
      query.where(filter, f.operator ? f.operator : '=', f.value);
    }

    const count = await query.clone().clearColumns().count('*', 'count').takeFirst().asRaw<{ count: number }>();
    const result = await query;

    return new Ok({
      Data: result.map((x) => x.dehydrateWithRelations()).map((x) => permission.filter(x)),
      Total: count,
    });
  }
}
