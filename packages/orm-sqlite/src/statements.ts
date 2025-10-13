/* eslint-disable prettier/prettier */
import { NewInstance } from '@spinajs/di';
import { JoinMethod, IJoinStatementOptions } from '@spinajs/orm';
import { SqlJoinStatement } from '@spinajs/orm-sql';
import { NotSupported } from '@spinajs/exceptions';

@NewInstance()
export class SqlLiteJoinStatement extends SqlJoinStatement {
  constructor(protected _options: IJoinStatementOptions) {
    super(_options);

    if (_options.method === JoinMethod.RIGHT || _options.method === JoinMethod.RIGHT_OUTER) {
      throw new NotSupported(`join method ${_options.method} is not supported by sqlite driver`);
    }
  }
}
