import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

/** The connection name of the audit table; map it to a real connection with `db.Aliases`. */
export const AUDIT_CONNECTION = 'authz-audit';
export const AUDIT_TABLE = 'authz_audit';

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
