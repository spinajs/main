/* eslint-disable prettier/prettier */
import { NewInstance } from '@spinajs/di';
import { RawQuery } from '@spinajs/orm';
import { SqlJoinStatement } from '@spinajs/orm-sql';
import { JoinMethod } from '@spinajs/orm/lib/enums';
import { NotSupported } from '@spinajs/exceptions';

@NewInstance()
export class SqlLiteJoinStatement extends SqlJoinStatement {
  constructor(table: string | RawQuery, method: JoinMethod, foreignKey: string, primaryKey: string, alias: string, tableAlias: string) {
    super(table, method, foreignKey, primaryKey, alias, tableAlias);

    if (method === JoinMethod.RIGHT || method === JoinMethod.RIGHT_OUTER) {
      throw new NotSupported(`join method ${method} is not supported by sqlite driver`);
    }
  }
}
