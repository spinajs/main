/* eslint-disable prettier/prettier */
import { Constructor, NewInstance } from '@spinajs/di';
import { RawQuery, JoinMethod, ModelBase, SelectQueryBuilder } from '@spinajs/orm';
import { SqlJoinStatement } from '@spinajs/orm-sql';
import { NotSupported } from '@spinajs/exceptions';

@NewInstance()
export class SqlLiteJoinStatement extends SqlJoinStatement {
  constructor(builder: SelectQueryBuilder<any>, sourceModel: Constructor<ModelBase>, table: string | RawQuery, method: JoinMethod, foreignKey: string, primaryKey: string, alias: string, tableAlias: string) {
    super(builder, sourceModel, table, method, foreignKey, primaryKey, alias, tableAlias);

    if (method === JoinMethod.RIGHT || method === JoinMethod.RIGHT_OUTER) {
      throw new NotSupported(`join method ${method} is not supported by sqlite driver`);
    }
  }
}
