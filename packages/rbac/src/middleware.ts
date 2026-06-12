import { Autoinject, DI, Injectable } from '@spinajs/di';
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

const PERMISSION_SCOPE_TO_QUERY = {
  deleteOwn: "DeleteQueryBuilder",
  deleteAny: "DeleteQueryBuilder",
  updateOwn: "UpdateQueryBuilder",
  updateAny: "UpdateQueryBuilder",
  readOwn: "SelectQueryBuilder",
  readAny: "SelectQueryBuilder",
  createOwn: "InsertQueryBuilder",
  createAny: "InsertQueryBuilder"
}

@Injectable(QueryMiddleware)
export class RbacModelPermissionMiddleware extends QueryMiddleware {

  @Logger('RBAC')
  protected Log!: Log;

  @Autoinject()
  protected Ac!: AccessControl;

  beforeQueryExecution(_query: QueryBuilder<any>): void { }
  afterQueryCreation(builder: QueryBuilder) {
    if (typeof AsyncLocalStorage === 'function') {
      const store = DI.get(AsyncLocalStorage);
      if (store) {
        const storage = store.getStore() as IRbacAsyncStorage;

        if (storage && storage.SkipModelPermissionCheck) {
          this.Log.trace(`Model permission check disabled for current execution context, skipping rbac check`);
          return;
        }

        if (storage && storage.User) {
          // add where statement
          const descriptor = extractModelDescriptor(builder.Model) as IRbacModelDescriptor;

          // if model does not have @Resource() decorator set, model name is used
          const resource = descriptor.RbacResource; // ?? descriptor.Name; // temporarly remove resource assign

          // no rbac is set do nothing
          if (!resource) {
            return;
          }

          if (storage?.PermissionScope) {
            if (!PERMISSION_SCOPE_TO_QUERY[storage.PermissionScope]) {
              this.Log.warn(`Permission scope ${storage.PermissionScope} does not match any query type, skipping rbac check`);
              return;
            }

            if (builder.constructor.name !== PERMISSION_SCOPE_TO_QUERY[storage.PermissionScope]) {
              this.Log.warn(`Permission scope ${storage.PermissionScope} does not match query type ${builder.constructor.name}, skipping rbac check`);
              return;
            }
          }

          const ownScope = storage?.PermissionScope ?? (QUERY_TO_PERMISSION as any)[builder.constructor.name].own;
          const anyScope = storage?.PermissionScope ?? (QUERY_TO_PERMISSION as any)[builder.constructor.name].all;
          const roles = storage.ActiveRole ? [storage.ActiveRole] : storage.User.Role;

          let canAny = false;
          let canOwn = false;
          try {
            canAny = (this.Ac!.can(roles) as any)[anyScope](resource).granted;
            canOwn = (this.Ac!.can(roles) as any)[ownScope](resource).granted;
          } catch (err) {
            // accesscontrol throws eg. "Role not found" when role has no grants registered
            // treat as no permission so caller gets Forbidden instead of library error
            this.Log.trace(`Permission check for roles ${roles} on resource ${resource} failed: ${(err as Error).message}, treating as no permission`);
          }


          if (builder instanceof SelectQueryBuilder || builder instanceof UpdateQueryBuilder || builder instanceof DeleteQueryBuilder) {

            /**
             * Model can have custom rbac permission check
             */
            const rbacFunc = (builder.Model as any)?.rbac as Function;
            if (canAny) {
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
            if (canOwn) {
              builder.values({
                [descriptor.OwnerField]: storage.User.PrimaryKeyValue
              });
            } else if (!canAny) {
              throw new Forbidden(`User does not have permission to access ${resource}:insert permission`);
            }
          }
        }
      }
    }
  }
}
