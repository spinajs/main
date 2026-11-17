import { AUTHZ_CONNECTION, AuthzConfigError, CHANGE_KINDS } from '@spinajs/authz';
import type { ChangeKind, ResourceType } from '@spinajs/authz';
import { Connection, DateTime as DateTimeColumn, InsertBehaviour, Model, ModelBase, Primary } from '@spinajs/orm';
// A value import: @DateTime() reads the property's design type.
import { DateTime } from 'luxon';

import { selectFrom } from '../records.js';
import { HORIZON_TABLE, HORIZON_WIDTHS } from './table.js';

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
}

/** The `resource_type` a kind's row is stored under. */
export const horizonType = (kind: ChangeKind, resourceType: ResourceType | undefined): string => (kind === 'column' ? (resourceType ?? '') : '');

const rowKey = (kind: string, type: string): string => `${kind}#${type}`;

function checkType(type: unknown, where: string): void {
  if (typeof type !== 'string' || type === '' || type.length > HORIZON_WIDTHS.resource_type) throw new AuthzConfigError(`${where}: a resource type must be a non-empty string of at most ${HORIZON_WIDTHS.resource_type} characters, got ${JSON.stringify(type)}`);
}

/**
 * Records that this boot writes every change of `kinds` and of the `column` kind of `columnTypes` to the log: a row
 * that exists keeps its earlier `since`. The `column` rows of `optedOut` (`changelog: false`) are deleted.
 */
export async function recordCoverage(kinds: readonly ChangeKind[], columnTypes: readonly ResourceType[], optedOut: readonly ResourceType[], now: Date = new Date()): Promise<void> {
  const where = 'recordCoverage';
  for (const k of kinds) if (!(CHANGE_KINDS as readonly string[]).includes(k)) throw new AuthzConfigError(`${where}: unknown kind ${JSON.stringify(k)}`);
  for (const t of [...columnTypes, ...optedOut]) checkType(t, where);
  const since = DateTime.fromJSDate(now);
  const rows: Array<{ kind: string; resource_type: string; since: DateTime }> = [...new Set(kinds.filter((k) => k !== 'column'))].map((kind) => ({ kind, resource_type: '', since }));
  rows.push(...[...new Set(columnTypes)].map((t) => ({ kind: 'column', resource_type: t, since })));
  const known = new Set((await selectFrom(HorizonRecord).onPrimary()).map((r) => rowKey(r.kind, r.resource_type)));
  // spinajs-orm-ignore ORM102: one insert per kind or type, on the first boot that covers it; the model's array insert takes no ignore
  for (const row of rows) if (!known.has(rowKey(row.kind, row.resource_type))) await HorizonRecord.insert(row, InsertBehaviour.InsertOrIgnore);
  if (optedOut.length > 0) await HorizonRecord.destroy().where('kind', 'column').whereIn('resource_type', [...optedOut]);
}

/** A write of `kind` escaped the log: coverage starts again at `now`. For `column` without a type, of every type. */
export async function restartCoverage(kind: ChangeKind, resourceType: ResourceType | undefined, now: Date): Promise<void> {
  const since = DateTime.fromJSDate(now);
  const q = HorizonRecord.update({ since }).where('kind', kind).where('since', '<', since);
  if (kind !== 'column' || resourceType !== undefined) q.where('resource_type', horizonType(kind, resourceType));
  await q;
}
