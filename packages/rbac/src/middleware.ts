import { DI, Injectable } from '@spinajs/di';
import { extractModelDescriptor, QueryBuilder, QueryMiddleware, SelectQueryBuilder } from '@spinajs/orm';
import { AsyncLocalStorage } from 'async_hooks';
import { IRbacAsyncStorage, IRbacModelDescriptor } from './interfaces.js';
import { AccessControl } from 'accesscontrol';
import { Forbidden } from '@spinajs/exceptions';

@Injectable(QueryMiddleware)
export class RbacModelPermissionMiddleware extends QueryMiddleware {
  beforeQueryExecution(_query: QueryBuilder<any>): void {}
  afterQueryCreation(builder: QueryBuilder) {
    if (builder instanceof SelectQueryBuilder) {
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

            const canAny = (ac.can(storage.User.Role) as any)['readAny'](resource).granted;
            const canOwn = (ac.can(storage.User.Role) as any)['readOwn'](resource).granted;

            // can get all resources
            if (canAny) {
              return;
            }

            if (canOwn) {
              builder.andWhere(descriptor.OwnerField, storage.User.PrimaryKeyValue);
              return;
            }

            throw new Forbidden(`User does not have permission to access ${resource}:read permission`);
          }
        }
      }
    }
  }
}
