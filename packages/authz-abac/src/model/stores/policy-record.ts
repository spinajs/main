import { AUTHZ_CONNECTION, AuthzConfigError } from '@spinajs/authz';
import type { AuthzTx } from '@spinajs/authz';
import type { Policy } from '../../contracts.js';
import { Connection, ConnectionMismatch, DateTime as DateTimeColumn, Json, Model, ModelBase, NotAnOrmDriver, OrmConnectionMissing, OrmNotResolved, Primary, TransactionRequired, requireModelTransaction } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
// A value import: @DateTime() reads the property's design type.
import { DateTime } from 'luxon';

export const AUTHZ_POLICY_TABLE = 'authz_policy';

// Widths of the authz_policy columns a policy fills (design §9.1).
export const POLICY_ID_MAX_LENGTH = 64;
export const POLICY_TEXT_MAX_LENGTH = 64;
export const POLICY_ACTOR_MAX_LENGTH = 100;

/** An `authz_policy` row. */
export interface PolicyFields {
  readonly id: string;
  readonly effect: string;
  readonly permissions: readonly string[];
  readonly resource_types: readonly string[] | null;
  readonly principal_types: readonly string[] | null;
  readonly actor_types: readonly string[] | null;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly condition: NonNullable<Policy['when']> | null;
  readonly fields: NonNullable<Policy['fields']> | null;
  readonly reason: string | null;
  readonly priority: number | null;
  readonly expires_at: DateTime | null;
  readonly created_by: string | null;
  readonly created_at: DateTime;
}

/** The columns a write passes. */
export type PolicyValues = { -readonly [K in keyof PolicyFields]?: PolicyFields[K] };

// expires_at is typed DateTime: @DateTime() reads the design type, which `DateTime | null` compiles to
// Object. PolicyFields carries the null.
@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_POLICY_TABLE)
export class PolicyRecord extends ModelBase<PolicyRecord> implements PolicyFields {
  @Primary({ generated: 'assigned' })
  public id!: string;

  public effect!: string;

  @Json()
  public permissions!: readonly string[];

  @Json()
  public resource_types!: readonly string[] | null;

  @Json()
  public principal_types!: readonly string[] | null;

  @Json()
  public actor_types!: readonly string[] | null;

  public scope_type!: string;

  public scope_id!: string;

  @Json()
  public condition!: NonNullable<Policy['when']> | null;

  @Json()
  public fields!: NonNullable<Policy['fields']> | null;

  public reason!: string | null;

  public priority!: number | null;

  @DateTimeColumn()
  public expires_at!: DateTime;

  public created_by!: string | null;

  @DateTimeColumn()
  public created_at!: DateTime;
}

/**
 * The driver of `tx`, an `AuthzAdmin` transaction on the connection of `authz_policy` (design §9.2).
 * PolicyRecord queries join it; on another connection a write would land where the reads never look.
 */
export function requirePolicyTransaction(tx: AuthzTx, where: string): OrmDriver {
  try {
    return requireModelTransaction(PolicyRecord, tx?.driver);
  } catch (err) {
    if (err instanceof NotAnOrmDriver) {
      throw new AuthzConfigError(`${where}: AuthzTx.driver must be the OrmDriver of an AuthzAdmin transaction`, { cause: err });
    }
    if (err instanceof TransactionRequired) {
      throw new AuthzConfigError(`${where}: stores write only inside an AuthzAdmin transaction, and none is in scope`, { cause: err });
    }
    if (err instanceof ConnectionMismatch) {
      throw new AuthzConfigError(`${where}: the AuthzTx runs on connection ${JSON.stringify(err.actual)}, but ${err.table} is on connection ${JSON.stringify(err.expected)} (db.Aliases.${AUTHZ_CONNECTION})`, { cause: err });
    }
    if (err instanceof OrmNotResolved) {
      throw new AuthzConfigError(`${PolicyRecord.name}: the Orm is not resolved yet; resolve it (await DI.resolve(Orm)) before the authz tables are used`, { cause: err });
    }
    if (err instanceof OrmConnectionMissing) {
      throw new AuthzConfigError(`${PolicyRecord.name}: no ORM connection answers to "${AUTHZ_CONNECTION}"; set db.Aliases.${AUTHZ_CONNECTION}`, { cause: err });
    }
    throw err;
  }
}
