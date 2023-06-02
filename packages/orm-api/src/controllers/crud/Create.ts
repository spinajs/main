import { IModelStatic, Orm } from '@spinajs/orm';
import { BasePath, Ok, Post, Policy, BodyField, Param } from '@spinajs/http';
import { Autoinject } from '@spinajs/di';
import { Forbidden, ResourceNotFound, UnexpectedServerError } from '@spinajs/exceptions';
import { User } from '@spinajs/rbac-http';
import _ from 'lodash';
import { ModelType } from '../../route-args/ModelType.js';
import { FindModelType } from '../../policies/FindModelType.js';
import { Log, Logger } from '@spinajs/log';
import { AccessControl, IRbacModelDescriptor, User as UserModel } from '@spinajs/rbac';
import { Permission } from 'accesscontrol';
import { Crud } from './../../interfaces.js';

@BasePath('crud')
@Policy(FindModelType)
export class CrudCreate extends Crud {
  @Logger('orm-http:api')
  protected Log: Log;

  @Autoinject()
  protected Orm: Orm;

  @Autoinject()
  protected Ac: AccessControl;

  protected checkAny(resource: string, user?: UserModel): Permission {
    // if we have user
    if (user) {
      return this.Ac.can(user.Role).createAny(resource);
    } else {
      // if not try guest account
      return this.Ac.can('guest').createAny(resource);
    }
  }

  protected checkOwn(resource: string, user?: UserModel): Permission {
    const role = user ? user.Role : 'guest';
    return this.Ac.can(role).createOwn(resource);
  }

  @Post(':model')
  public async save(@ModelType() model: IModelStatic, @BodyField() data: unknown, @User() user?: UserModel) {
    const mDescriptor = this.getModelDescriptor(model) as IRbacModelDescriptor;
    let resource = mDescriptor.RbacResource ? mDescriptor.RbacResource : mDescriptor.Name;
    let permission: Permission = this.checkAny(resource, user);
    const toInsert = (Array.isArray(data) ? data : [data]).map((x) => new model(x));

    if (!permission.granted) {
      permission = this.checkOwn(resource, user);
      if (permission.granted && user) {
        if (model.checkOwnership) {
          if (_.some(toInsert, (x) => !model.checkOwnership(x, user))) {
            throw new Forbidden(`You can only create ${resource} that is assigned to you !`);
          }
        } else {
          throw new UnexpectedServerError(`Resource ${resource} does not have checkOwnership method implemented`);
        }
      }

      if (!permission.granted) {
        throw new Forbidden(`You cannot create resource ${resource}`);
      }
    }

    await model.insert(toInsert);
    return new Ok(toInsert.map((x) => x.dehydrate()));
  }

  @Post(':model/:id/:relation')
  public async insertRelation(@ModelType() model: IModelStatic, @Param() id: any, @Param() relation: string, @BodyField() data: unknown, @User() user?: UserModel) {
    const mDescriptor = this.getModelDescriptor(model) as IRbacModelDescriptor;
    const rDescriptor = this.getRelationDescriptor(model, relation);
    let resource = mDescriptor.RbacResource ? mDescriptor.RbacResource : mDescriptor.Name;
    let permission: Permission = this.checkAny(resource, user);
    const toInsert = (Array.isArray(data) ? data : [data]).map((x) => permission.filter(x)).map((x) => new rDescriptor.TargetModel(x));

    const m = await model.get(id);
    if (!m) {
      throw new ResourceNotFound(`Record with id ${id} not found`, {
        Resource: model.name,
        [mDescriptor.PrimaryKey]: id,
      });
    }

    if (!permission.granted) {
      permission = this.checkOwn(resource, user);
      if (permission.granted && user) {
        if (model.checkOwnership) {
          if (!model.checkOwnership(m, user)) {
            throw new Forbidden(`Cannot create relations for  ${resource} that you do not own`);
          }

          if (_.some(toInsert, (x) => !model.checkOwnership(x, user))) {
            throw new Forbidden(`You can only create ${resource} that you own`);
          }
        } else {
          throw new UnexpectedServerError(`Resource ${resource} does not have checkOwnership method implemented`);
        }
      }

      if (!permission.granted) {
        throw new Forbidden(`You do not access to ${resource}`);
      }
    }

    toInsert.forEach((x) => {
      m.attach(x);
    });

    await rDescriptor.TargetModel.insert(toInsert);

    return new Ok(toInsert.map((x) => x.dehydrate()));
  }
}
