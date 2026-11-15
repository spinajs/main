import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary } from '@spinajs/orm';
// A value import: @DateTime() reads the property's design type.
import { DateTime } from 'luxon';

import { CHANGE_LOG_TABLE } from './table.js';

/** An `authz_change_log` row; `payload` is JSON text. */
@Connection(AUTHZ_CONNECTION)
@Model(CHANGE_LOG_TABLE)
export class ChangeLogRecord extends ModelBase<ChangeLogRecord> {
  @Primary()
  public seq!: number;

  @DateTimeColumn()
  public at!: DateTime;

  public kind!: string;

  public op!: string;

  public key!: string;

  public payload!: string | null;

  public actor!: string | null;

  public trace_id!: string | null;
}
