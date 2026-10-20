import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { AUTHZ_ADMIN_IDEMPOTENCY_TABLE } from '../../stores/tables.js';

/** What DbAuthzAdminBackend remembers of a committed batch; `results` and `rows` are its own JSON, which revives Dates. */
@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_ADMIN_IDEMPOTENCY_TABLE)
export class AdminIdempotencyRecord extends ModelBase<AdminIdempotencyRecord> {
  @Primary({ generated: 'assigned' })
  public domain!: string;

  @Primary({ generated: 'assigned' })
  public actor!: string;

  @Primary({ generated: 'assigned' })
  public idem_key!: string;

  public results!: string;

  public rows!: string;

  @DateTimeColumn()
  public expires_at!: DateTime;

  @DateTimeColumn()
  public created_at!: DateTime;
}
