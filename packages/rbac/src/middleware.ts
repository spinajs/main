import { Injectable } from '@spinajs/di';
import { QueryBuilder, QueryMiddleware, SelectQueryBuilder } from '@spinajs/orm';

@Injectable(QueryMiddleware)
export class RbacModelPermissionMiddleware extends QueryMiddleware {
  beforeQueryExecution(_query: QueryBuilder<any>): void {
    
  }
  afterQueryCreation(builder: QueryBuilder) {
    if (builder instanceof SelectQueryBuilder) {
      //builder.Model.
    }
  }
}
