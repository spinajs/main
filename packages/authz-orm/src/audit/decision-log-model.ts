import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { AUDIT_CONNECTION } from './names.js';

export const DECISION_LOG_TABLE = 'authz_decision_log';

/** One `authz_decision_log` row: a `DecisionRecord`. Column names follow the table, not the record. */
@Connection(AUDIT_CONNECTION)
@Model(DECISION_LOG_TABLE)
export class AuthzDecisionLogEntry extends ModelBase<AuthzDecisionLogEntry> {
  /** The record's UUIDv7, also the decision's id. */
  @Primary()
  public id!: string;

  @DateTimeColumn()
  public at!: DateTime;

  public trace_id!: string | null;

  public span_id!: string | null;

  public domain!: string;

  /** principalKey() */
  public principal!: string;

  public actor!: string | null;

  public permission!: string;

  /** resourceKey() */
  public resource!: string;

  public allowed!: boolean;

  public reason!: string | null;

  public cached!: boolean;

  public policy_hash!: string;

  /** JSON */
  public model_versions!: string | null;

  public inputs_hash!: string;

  /** JSON, only with authz.decisionLog.captureInputs */
  public inputs!: string | null;

  /** JSON `DecisionRecord.facts`; null on rows logged before AuthzDecisionLogFacts_2026_11_06_00_00_00. */
  public facts!: string | null;

  /** Optional, not `DateTime | null`: `@DateTime()` reads `design:type`, which a union emits as `Object`. */
  @DateTimeColumn()
  public logged_at?: DateTime;

  public duration_ms!: number | null;
}
