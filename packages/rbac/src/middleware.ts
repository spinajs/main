import { Injectable } from '@spinajs/di';
import { QueryBuilder, QueryMiddleware, SelectQueryBuilder } from '@spinajs/orm';

@Injectable(QueryMiddleware)
export class RbacModelPermissionMiddleware extends QueryMiddleware {
  afterQueryCreation(builder: QueryBuilder) {
    if (builder instanceof SelectQueryBuilder) {
      //builder.Model.
    }
  }
}
