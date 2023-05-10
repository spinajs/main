import { Permission } from 'accesscontrol';
import { Orm, SortOrder, IModelStatic } from '@spinajs/orm';
import { Get, Ok, Query, Param, Policy, BasePath } from '@spinajs/http';
import { User } from '@spinajs/rbac-http';
import { User as UserModel, IRbacModelDescriptor, AccessControl } from '@spinajs/rbac';
import { Autoinject } from '@spinajs/di';
import { BadRequest, Forbidden, ResourceNotFound, UnexpectedServerError } from '@spinajs/exceptions';

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

  @Autoinject()
  protected Ac: AccessControl;

  protected checkAny(resource: string, user?: UserModel): Permission {
    // if we have user
    if (user) {
      return this.Ac.can(user.Role).readAny(resource);
    } else {
      // if not try guest account
      return this.Ac.can('guest').readAny(resource);
    }
  }

  protected checkOwn(resource: string, user?: UserModel): Permission {
    // if we have user
    if (user) {
      return this.Ac.can(user.Role).readOwn(resource);
    } else {
      // if not try guest account
      return this.Ac.can('guest').readOwn(resource);
    }
  }

  /**
   *
   * Creates query on model and ansures that user have proper permission to access it
   *
   * @param model model to query against
   * @param user user for permission check
   * @returns
   */
  protected getSafeQuery(model: IModelStatic, user?: UserModel) {
    const descriptor = this.getModelDescriptor(model) as IRbacModelDescriptor;
    const query = model.query();

    // retrieve resource name, if model does not have @OrmResource decorator set
    // model name is default resource name
    let resource = descriptor.RbacResource ? descriptor.RbacResource : descriptor.Name;
    let permission: Permission = this.checkAny(resource, user);

    if (!permission.granted) {
      // permission for readAny not  granted, check for own
      permission = this.checkOwn(resource, user);
      if (permission.granted && user) {
        if (model.ensureOwnership) {
          model.ensureOwnership(query, user, descriptor);
        } else {
          throw new UnexpectedServerError(`Resource ${resource} does not have checkOwnership method implemented`);
        }
      }

      if (!permission.granted) {
        throw new Forbidden(`You do not access to ${resource}`);
      }
    }

    return { query, permission };
  }

  @Get(':model')
  public async getAll(@ModelType() model: IModelStatic, @Query() getParams: QueryArgs, @Query() filters: QueryFilter, @Query() includes: QueryIncludes, @User() user?: UserModel) {
    const { query, permission } = this.getSafeQuery(model, user);
    query
      .where(filters)
      .select('*')
      .populate(includes)
      .order(getParams.order, getParams.orderDirection ?? SortOrder.ASC)
      .skip(getParams.page * getParams.perPage ?? 0)
      .take(getParams.perPage ?? 10);

    const count = await query.clone().clearColumns().count('*', 'count').takeFirst().asRaw<{ count: number }>();
    const result = await query;

    return new Ok({
      Data: result.map((x) => x.dehydrateWithRelations()).map((x) => permission.filter(x)),
      Total: count.count,
    });
  }

  @Get(':model/:id')
  public async get(@User() user: UserModel, @ModelType() model: IModelStatic, @Param() id: number, @Query() includes: QueryIncludes) {
    const descriptor = this.getModelDescriptor(model) as IRbacModelDescriptor;
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
    const mDescriptor = this.getModelDescriptor(model);
    const rDescriptor = this.getRelationDescriptor(model, relation);
    const rmDescriptor = this.getModelDescriptor(rDescriptor.TargetModel);
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
    const mDescriptor = this.getModelDescriptor(model);
    const rDescriptor = this.getRelationDescriptor(model, relation);
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
      .where(filters)
      .where(rDescriptor.ForeignKey, id)
      .select('*')
      .populate(includes)
      .order(params.order, params.orderDirection ?? SortOrder.ASC)
      .skip(params.page * params.perPage ?? 0)
      .take(params.perPage ?? 10);

    const count = await query.clone().clearColumns().count('*', 'count').takeFirst().asRaw<{ count: number }>();
    const result = await query;

    return new Ok({
      Data: result.map((x) => x.dehydrateWithRelations()).map((x) => permission.filter(x)),
      Total: count,
    });
  }
}
