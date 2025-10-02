import { DI, Injectable } from '@spinajs/di';
import { DeleteQueryBuilder, extractModelDescriptor, InsertQueryBuilder, OrmException, QueryBuilder, QueryMiddleware, SelectQueryBuilder, UpdateQueryBuilder } from '@spinajs/orm';
import { AsyncLocalStorage } from 'async_hooks';
import { IRbacAsyncStorage, IRbacModelDescriptor } from './interfaces.js';
import { AccessControl } from 'accesscontrol';
import { Forbidden } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log-common';

const QUERY_TO_PERMISSION = {
  DeleteQueryBuilder: {
    own: "deleteOwn",
    all: "deleteAny"
  },
  UpdateQueryBuilder: {
    own: "updateOwn",
    all: "updateAny"
  },
  SelectQueryBuilder: {
    own: "readOwn",
    all: "readAny"
  }

}

@Injectable(QueryMiddleware)
export class RbacModelPermissionMiddleware extends QueryMiddleware {

  @Logger('RBAC')
  protected Log: Log;

  beforeQueryExecution(_query: QueryBuilder<any>): void { }
  afterQueryCreation(builder: QueryBuilder) {
    if (typeof AsyncLocalStorage === 'function') {
      const store = DI.get(AsyncLocalStorage);
      if (store) {
        const storage = store.getStore() as IRbacAsyncStorage;

        if (storage && storage.User) {
          // add where statement
          const descriptor = extractModelDescriptor(builder.Model) as IRbacModelDescriptor;
          const ac = DI.get<AccessControl>('AccessControl');

          // if model does not have @Resource() decorator set, model name is used
          const resource = descriptor.RbacResource;

          // no rbac is set do nothing
          if (!resource) {
            return;
          }

          if (builder instanceof SelectQueryBuilder || builder instanceof UpdateQueryBuilder || builder instanceof DeleteQueryBuilder) {
            const canAny = (ac.can(storage.User.Role) as any)[(QUERY_TO_PERMISSION as any)[builder.constructor.name].all](resource).granted;
            const canOwn = (ac.can(storage.User.Role) as any)[(QUERY_TO_PERMISSION as any)[builder.constructor.name].own](resource).granted;

            /**
             * Model can have custom rbac permission check
             */
            const rbacFunc = (builder.Model as any)?.rbac as Function;

            /**
             * First check if we are allowed to only read own
             */

            const any = ["readAny", "updateAny", "deleteAny"];
            const own = ["readOwn", "updateOwn", "deleteOwn"];

            if (storage)
              if (storage.PermissionScope) {
                if (any.includes(storage.PermissionScope)) {
                  if (canAny) {
                    this.Log.trace(`Resource ${resource}:any permission granted for ${storage.User.Role}, scope: ${storage.PermissionScope}`);
                    return;
                  } else {
                    throw new Forbidden(`User does not have permission to access ${resource}:any permission`);
                  }
                }

                if (own.includes(storage.PermissionScope)) {
                  if (canOwn) {
                    this.Log.trace(`Resource ${resource}:own permission granted for ${storage.User.Role}, scope: ${storage.PermissionScope}`);
                    if (rbacFunc) {
                      this.Log.trace(`Applying custom rbac func for ${resource}`);
                      rbacFunc.call(builder, storage.User);
                    } else if (descriptor.OwnerField) {

                      this.Log.trace(`Applying owner field restriction for ${resource}`);
                      builder.andWhere(descriptor.OwnerField, storage.User.PrimaryKeyValue);
                    } else {
                      this.Log.error(`Model ${descriptor.Name} does not have OwnerField set or static rbac function, cannot apply :own permission`); throw new OrmException(`Model ${descriptor.Name} does not have OwnerField set, cannot apply :own permission`);
                    }

                    return;
                  }
                }

                throw new Forbidden(`User does not have permission to access ${resource}:own permission`);

              } else if (canAny) {
                this.Log.trace(`Resource ${resource}:any permission granted for ${storage.User.Role}, scope: ${storage.PermissionScope}`);
                return;
              } else if (canOwn) {
                this.Log.trace(`Resource ${resource}:own permission granted for ${storage.User.Role}, scope: ${storage.PermissionScope}`);
                if (rbacFunc) {

                  this.Log.trace(`Applying custom rbac func for ${resource}`);

                  rbacFunc.call(builder, storage.User);
                } else if (descriptor.OwnerField) {

                  this.Log.trace(`Applying owner field restriction for ${resource}`);
                  builder.andWhere(descriptor.OwnerField, storage.User.PrimaryKeyValue);
                } else {
                  this.Log.error(`Model ${descriptor.Name} does not have OwnerField set or static rbac function, cannot apply :own permission`); throw new OrmException(`Model ${descriptor.Name} does not have OwnerField set, cannot apply :own permission`);
                }
              }
              else {
                throw new Forbidden(`User does not have permission to access ${resource}:read permission`);
              }
          } else if (builder instanceof InsertQueryBuilder) {

            const canAny = (ac.can(storage.User.Role) as any)['createAny'](resource).granted;
            const canOwn = (ac.can(storage.User.Role) as any)['createOwn'](resource).granted;


            if (storage.PermissionScope && storage.PermissionScope === "createOwn") {
              if (!canOwn) {
                throw new Forbidden(`User does not have permission to access ${resource}:insert permission`);

              }

              builder.values({
                [descriptor.OwnerField]: storage.User.PrimaryKeyValue
              })

              return;
            } else if (canAny) {
              return;
            } else if (canOwn) {
              builder.values({
                [descriptor.OwnerField]: storage.User.PrimaryKeyValue
              })
              return;
            } else {
              throw new Forbidden(`User does not have permission to access ${resource}:insert permission`);
            }

          }
        }
      }
    }
  }
}
