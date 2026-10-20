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

  /** The instant of the decision; read back as a DateTime in UTC. */
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
