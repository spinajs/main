import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Connection, DateTime as DateTimeColumn, Int64, Json, Model, ModelBase, Primary, type ISelectQueryBuilder, type IWhereBuilder } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { AUTHZ_ASSIGNMENT_TABLE, AUTHZ_LINK_TABLE, AUTHZ_RULE_SUBJECT_TABLE, AUTHZ_RULE_TABLE, AUTHZ_SUBJECT_MEMBERSHIP_TABLE, AUTHZ_VERSION_TABLE } from './tables.js';

// A nullable datetime column is typed `DateTime` on its record: @DateTime() reads the design type, which
// `DateTime | null` compiles to Object. The `*Fields` interfaces carry the null.

/** An `authz_assignment` row. */
export interface AssignmentFields {
  readonly id: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly subject_role: string;
  readonly subject_key: string;
  readonly role: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly tags: string;
  readonly expires_at: DateTime | null;
  /** No column: selected by withExpirySet, true when the row holds an expires_at. */
  readonly expires_at_set?: boolean;
  readonly granted_by: string | null;
  readonly source: string;
  readonly created_at: DateTime;
}

@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_ASSIGNMENT_TABLE)
export class AssignmentRecord extends ModelBase<AssignmentRecord> implements AssignmentFields {
  @Primary({ generated: 'assigned' })
  public id!: string;

  public subject_type!: string;

  public subject_id!: string;

  public subject_role!: string;

  public subject_key!: string;

  public role!: string;

  public scope_type!: string;

  public scope_id!: string;

  public tags!: string;

  @DateTimeColumn()
  public expires_at!: DateTime;

  public expires_at_set?: boolean;

  public granted_by!: string | null;

  public source!: string;

  @DateTimeColumn()
  public created_at!: DateTime;
}

/** An `authz_subject_membership` row. */
export interface MembershipFields {
  readonly member_key: string;
  readonly set_key: string;
  readonly depth: number;
  readonly expires_at: DateTime | null;
  /** No column: selected by withExpirySet, true when the row holds an expires_at. */
  readonly expires_at_set?: boolean;
}

@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_SUBJECT_MEMBERSHIP_TABLE)
export class MembershipRecord extends ModelBase<MembershipRecord> implements MembershipFields {
  @Primary({ generated: 'assigned' })
  public member_key!: string;

  @Primary({ generated: 'assigned' })
  public set_key!: string;

  public depth!: number;

  @DateTimeColumn()
  public expires_at!: DateTime;

  public expires_at_set?: boolean;
}

/** An `authz_rule` row; `definition` is the rule without the id, scope and expiry its columns hold. */
export interface RuleFields {
  readonly id: string;
  readonly kind: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly definition: object;
  readonly expires_at: DateTime | null;
  /** No column: selected by withExpirySet, true when the row holds an expires_at. */
  readonly expires_at_set?: boolean;
  readonly created_by: string | null;
  readonly created_at: DateTime;
}

@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_RULE_TABLE)
export class RuleRecord extends ModelBase<RuleRecord> implements RuleFields {
  @Primary({ generated: 'assigned' })
  public id!: string;

  public kind!: string;

  public scope_type!: string;

  public scope_id!: string;

  @Json()
  public definition!: object;

  @DateTimeColumn()
  public expires_at!: DateTime;

  public expires_at_set?: boolean;

  public created_by!: string | null;

  @DateTimeColumn()
  public created_at!: DateTime;
}

/** An `authz_rule_subject` row. */
export interface RuleSubjectFields {
  readonly rule_id: string;
  readonly list: string;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly subject_role: string;
}

@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_RULE_SUBJECT_TABLE)
export class RuleSubjectRecord extends ModelBase<RuleSubjectRecord> implements RuleSubjectFields {
  @Primary({ generated: 'assigned' })
  public rule_id!: string;

  @Primary({ generated: 'assigned' })
  public list!: string;

  @Primary({ generated: 'assigned' })
  public subject_type!: string;

  @Primary({ generated: 'assigned' })
  public subject_id!: string;

  // '' for a principal, which `generated: 'assigned'` refuses.
  @Primary()
  public subject_role!: string;
}

/** An `authz_link` row. */
export interface LinkFields {
  readonly id: string;
  readonly token_hash: string;
  readonly scope_type: string;
  readonly scope_id: string;
  readonly attributes: Readonly<Record<string, unknown>> | null;
  readonly expires_at: DateTime | null;
  /** No column: selected by withExpirySet, true when the row holds an expires_at. */
  readonly expires_at_set?: boolean;
  readonly revoked_at: DateTime | null;
  readonly created_by: string | null;
  readonly created_at: DateTime;
}

@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_LINK_TABLE)
export class LinkRecord extends ModelBase<LinkRecord> implements LinkFields {
  @Primary({ generated: 'assigned' })
  public id!: string;

  public token_hash!: string;

  public scope_type!: string;

  public scope_id!: string;

  @Json()
  public attributes!: Readonly<Record<string, unknown>> | null;

  @DateTimeColumn()
  public expires_at!: DateTime;

  public expires_at_set?: boolean;

  @DateTimeColumn()
  public revoked_at!: DateTime;

  public created_by!: string | null;

  @DateTimeColumn()
  public created_at!: DateTime;
}

/** One `authz_version` row per domain. */
@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_VERSION_TABLE)
export class VersionRecord extends ModelBase<VersionRecord> {
  @Primary({ generated: 'assigned' })
  public domain!: string;

  @Int64('string')
  public version!: string;
}

/** What a write passes for a record's columns: a nullable column takes `null`, which its property type leaves out. */
export type RecordValues<R> = { [K in keyof R]?: R[K] | null };

/** `values` typed as the ORM's write methods take them. */
export function recordValues<R>(values: RecordValues<R>): Partial<R> {
  return values as Partial<R>;
}

export function toDateTime(date: Date): DateTime;
export function toDateTime(date: Date | null | undefined): DateTime | null;
export function toDateTime(date: Date | null | undefined): DateTime | null {
  return date ? DateTime.fromJSDate(date, { zone: 'utc' }) : null;
}

export function fromDateTime(value: DateTime): Date;
export function fromDateTime(value: DateTime | null | undefined): Date | null;
export function fromDateTime(value: DateTime | null | undefined): Date | null {
  return value ? value.toJSDate() : null;
}

/** The select with the flag that tells a NULL expires_at from a stored value the datetime converter read as null. */
export function withExpirySet<T>(query: ISelectQueryBuilder<T>): ISelectQueryBuilder<T> {
  query.select('*');
  query.selectCondition('expires_at_set', function () {
    whereExpiresAtSet(this);
  });
  return query;
}

// A builder typed by a generic row names no column; every record withExpirySet takes has expires_at.
function whereExpiresAtSet(where: IWhereBuilder<unknown>): void {
  where.whereNotNull('expires_at');
}

/**
 * A stored value that is no datetime (text, a MySQL zero date, a PostgreSQL infinity) reads as null, which would mean
 * "never expires"; it becomes an invalid Date instead, which the model refuses.
 */
export function expiryOf(row: { readonly expires_at: DateTime | null; readonly expires_at_set?: boolean }): Date | null {
  return row.expires_at_set === true && row.expires_at == null ? new Date(NaN) : fromDateTime(row.expires_at);
}
