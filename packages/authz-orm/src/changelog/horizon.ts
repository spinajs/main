import { AUTHZ_CONNECTION, AuthzConfigError, CHANGE_KINDS } from '@spinajs/authz';
import type { ChangeKind, ResourceType } from '@spinajs/authz';
import { Connection, DateTime as DateTimeColumn, InsertBehaviour, Model, ModelBase, Primary } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
// A value import: @DateTime() reads the property's design type.
import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';

import { tableOf } from '../ids.js';
import { selectFrom } from '../records.js';
import { changelogColumns, classesOf, entryOf } from '../registry.js';
import type { RelationColumn } from '../registry.js';
import { HORIZON_TABLE, HORIZON_WIDTHS, LOST_TABLE } from './table.js';

/** An `authz_change_log_horizon` row; `resource_type` is the type for `column` and `''` for every other kind. */
@Connection(AUTHZ_CONNECTION)
@Model(HORIZON_TABLE)
export class HorizonRecord extends ModelBase<HorizonRecord> {
  @Primary({ generated: 'assigned' })
  public kind!: string;

  // Part of the table's key, but not declared @Primary: the ORM refuses '' as an assigned key, and rows are only
  // ever addressed by query, never saved as instances.
  public resource_type!: string;

  @DateTimeColumn()
  public since!: DateTime;

  /** `column` rows: the {@link relationFingerprint} of the type when its coverage last started; null for other kinds. */
  public fingerprint!: string | null;
}

/** An `authz_change_log_lost` marker: a write of `kind` escaped the log at `at`; `resource_type` `''` for `column` means every type. */
@Connection(AUTHZ_CONNECTION)
@Model(LOST_TABLE)
export class LostRecord extends ModelBase<LostRecord> {
  @Primary()
  public id!: number;

  public kind!: string;

  public resource_type!: string;

  @DateTimeColumn()
  public at!: DateTime;
}

/** A type whose relation columns this boot records, with their {@link relationFingerprint}. */
export interface ColumnCoverage {
  readonly type: ResourceType;
  readonly fingerprint: string;
}

/**
 * sha256 (hex) over the sorted (table, relation, column, type, type column) of every relation column of a type's
 * models: a column declared later was not logged before, so a changed fingerprint restarts the type's coverage.
 */
export function relationFingerprint(models: ReadonlyArray<{ readonly table: string; readonly columns: readonly RelationColumn[] }>): string {
  const lines = models.flatMap((m) => m.columns.map((c) => JSON.stringify([m.table, c.relation, c.column, c.type ?? null, c.typeColumn ?? null]))).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** The {@link relationFingerprint} of the registered models of `type`. */
export function columnFingerprint(type: ResourceType): string {
  return relationFingerprint(
    classesOf(type).flatMap((m) => {
      const entry = entryOf(m);
      return entry ? [{ table: tableOf(m), columns: changelogColumns(entry) }] : [];
    }),
  );
}

/** The `resource_type` a kind's row is stored under. */
export const horizonType = (kind: ChangeKind, resourceType: ResourceType | undefined): string => (kind === 'column' ? (resourceType ?? '') : '');

const rowKey = (kind: string, type: string): string => `${kind}#${type}`;

function checkType(type: unknown, where: string): void {
  if (typeof type !== 'string' || type === '' || type.length > HORIZON_WIDTHS.resource_type) throw new AuthzConfigError(`${where}: a resource type must be a non-empty string of at most ${HORIZON_WIDTHS.resource_type} characters, got ${JSON.stringify(type)}`);
}

interface CoverageRow {
  readonly kind: string;
  readonly resource_type: string;
  readonly since: DateTime;
  readonly fingerprint: string | null;
}

/**
 * Records that this boot writes every change of `kinds` and of the `column` kind of `columnTypes` to the log: a row
 * that exists keeps its earlier `since`, unless a type given with a fingerprint finds another one (or none) stored,
 * which restarts it. A bare type is recorded without a fingerprint. The `column` rows of `optedOut`
 * (`changelog: false`) are deleted.
 */
export async function recordCoverage(kinds: readonly ChangeKind[], columnTypes: readonly (ResourceType | ColumnCoverage)[], optedOut: readonly ResourceType[], now: Date = new Date()): Promise<void> {
  const where = 'recordCoverage';
  for (const k of kinds) if (!(CHANGE_KINDS as readonly string[]).includes(k)) throw new AuthzConfigError(`${where}: unknown kind ${JSON.stringify(k)}`);
  const columns = new Map(columnTypes.map((c): [string, string | null] => (typeof c === 'string' ? [c, null] : [c.type, c.fingerprint])));
  for (const t of [...columns.keys(), ...optedOut]) checkType(t, where);
  const since = DateTime.fromJSDate(now);
  const rows: CoverageRow[] = [...new Set(kinds.filter((k) => k !== 'column'))].map((kind) => ({ kind, resource_type: '', since, fingerprint: null }));
  rows.push(...[...columns].map(([t, fingerprint]) => ({ kind: 'column', resource_type: t, since, fingerprint })));
  const known = new Map((await selectFrom(HorizonRecord).onPrimary()).map((r) => [rowKey(r.kind, r.resource_type), r]));
  // spinajs-orm-ignore ORM102: one statement per kind or type, on the first boot that covers it or changes its columns; the model's array insert takes no ignore
  for (const row of rows) {
    const found = known.get(rowKey(row.kind, row.resource_type));
    if (!found) await HorizonRecord.insert(row, InsertBehaviour.InsertOrIgnore);
    else if (row.fingerprint !== null && found.fingerprint !== row.fingerprint) await refingerprint(row.resource_type, row.fingerprint, since);
  }
  if (optedOut.length > 0) await HorizonRecord.destroy().where('kind', 'column').whereIn('resource_type', [...optedOut]);
}

/**
 * Restarts a type's column coverage under its new fingerprint; `since` only moves forward. Conditional on the stored
 * fingerprint, so nodes booting with the same one restart it once. Nodes of a rolling deploy with different ones each
 * restart it, which only under-claims.
 */
async function refingerprint(type: ResourceType, fingerprint: string, now: DateTime): Promise<void> {
  const differs = function (this: IWhereBuilder<unknown>) {
    this.whereNull('fingerprint').orWhere('fingerprint', '!=', fingerprint);
  };
  await HorizonRecord.update({ fingerprint, since: now }).where('kind', 'column').where('resource_type', type).where('since', '<', now).where(differs);
  await HorizonRecord.update({ fingerprint }).where('kind', 'column').where('resource_type', type).where(differs);
}

/** The later of the horizon's `since` and the last lost-write marker of the kind and type; undefined without a horizon row. */
export async function coverageStart(kind: ChangeKind, resourceType: ResourceType | undefined): Promise<Date | undefined> {
  const type = horizonType(kind, resourceType);
  const row = (await selectFrom(HorizonRecord).onPrimary().where('kind', kind).where('resource_type', type).first()) as HorizonRecord | undefined;
  if (row === undefined) return undefined;
  const types = kind === 'column' && type !== '' ? [type, ''] : [''];
  const marker = (await selectFrom(LostRecord).onPrimary().where('kind', kind).whereIn('resource_type', types).orderByDescending('at').first()) as LostRecord | undefined;
  const since = row.since.toJSDate();
  return marker !== undefined && marker.at.toMillis() > since.getTime() ? marker.at.toJSDate() : since;
}

/** A write of `kind` escaped the log: coverage starts again at `now`. For `column` without a type, of every type. */
export async function restartCoverage(kind: ChangeKind, resourceType: ResourceType | undefined, now: Date): Promise<void> {
  const since = DateTime.fromJSDate(now);
  const q = HorizonRecord.update({ since }).where('kind', kind).where('since', '<', since);
  if (kind !== 'column' || resourceType !== undefined) q.where('resource_type', horizonType(kind, resourceType));
  await q;
}
