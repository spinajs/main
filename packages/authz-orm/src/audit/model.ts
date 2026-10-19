import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { AUDIT_CONNECTION, AUDIT_TABLE } from './names.js';

export { AUDIT_CONNECTION, AUDIT_TABLE };

/** One `authz_audit` row: a `DecisionAudit` record. */
@Connection(AUDIT_CONNECTION)
@Model(AUDIT_TABLE)
export class AuthzAuditEntry extends ModelBase<AuthzAuditEntry> {
  @Primary({ generated: 'uuid' })
  public id!: string;

  /**
   * UTC wall time without an offset (the orm writes a DateTime in its own zone). Read back, it is a
   * DateTime in the local zone: `at.setZone('utc', { keepLocalTime: true })` gives the instant.
   */
  @DateTimeColumn()
  public at!: DateTime;

  public kind!: string;

  /** `type:id` */
  public principal!: string;

  public permission!: string | null;

  /** `resourceKey(resource)` */
  public resource!: string | null;

  public reason!: string | null;

  /** JSON */
  public trace!: string | null;
}
