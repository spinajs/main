import { rowsOf } from '@spinajs/audit-orm';
import { instantFromDb } from '@spinajs/orm';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';
import { isPlainObject, isStringArray } from '@spinajs/util';

export const HISTORY_COVERAGE_TABLE = 'history_coverage';

/** A trail name of `audit.trails`, a connection name as wide as an archive's `source`, a subject type. */
export const HISTORY_COVERAGE_WIDTHS = Object.freeze({ trail: 64, connection: 64, entity: 128 });

export interface CoverageKey {
  readonly trail: string;
  /** The configured name of the connection the entity is written on, never an alias. */
  readonly connection: string;
  readonly entity: string;
}

/** The columns of the entity's table as the last recording pass saw them. */
export interface CoverageColumns {
  /** Held by every event since the row's `since`. */
  readonly recorded: readonly string[];
  /** On the table but left out of the events: excluded, masked or not tracked. */
  readonly skipped: readonly string[];
}

// JSON.parse never returns undefined, so it marks text that does not parse.
function parsed(stored: unknown): unknown {
  if (typeof stored !== 'string') return stored;
  try {
    return JSON.parse(stored) as unknown;
  } catch {
    return undefined;
  }
}

function columnsOf(stored: unknown): CoverageColumns | undefined {
  const value = parsed(stored);
  if (!isPlainObject(value)) return undefined;
  const { recorded, skipped } = value;
  return isStringArray(recorded) && isStringArray(skipped) ? { recorded, skipped } : undefined;
}

/** Typed loosely: the MSSQL driver answers null for a missing table. */
export async function holdsCoverageTable(driver: OrmDriver): Promise<boolean> {
  const columns: unknown = await driver.tableInfo(HISTORY_COVERAGE_TABLE);
  return Array.isArray(columns) && columns.length > 0;
}

/** `columns` is undefined when the stored lists cannot be read. */
export async function readCoverage(driver: OrmDriver, key: CoverageKey): Promise<{ readonly since: Date; readonly columns: CoverageColumns | undefined } | undefined> {
  const select: SelectQueryBuilder<unknown> = driver.select().from(HISTORY_COVERAGE_TABLE);
  select.where('trail', key.trail).where('connection', key.connection).where('entity', key.entity);
  const [row] = rowsOf(await select.take(1));
  const since = instantFromDb(row?.since)?.toJSDate();
  return row === undefined || since === undefined ? undefined : { since, columns: columnsOf(row.columns) };
}

/** `orIgnore`: a replica booting at the same moment may have inserted the row, and whichever insert came first stays. */
export async function insertCoverage(driver: OrmDriver, key: CoverageKey, columns: CoverageColumns, since: Date): Promise<void> {
  await driver
    .insert()
    .into(HISTORY_COVERAGE_TABLE)
    .values({ trail: key.trail, connection: key.connection, entity: key.entity, since, columns: JSON.stringify(columns) })
    .orIgnore();
}

export async function writeCoverageColumns(driver: OrmDriver, key: CoverageKey, columns: CoverageColumns): Promise<void> {
  await driver
    .update()
    .in(HISTORY_COVERAGE_TABLE)
    .update({ columns: JSON.stringify(columns) })
    .where('trail', key.trail)
    .where('connection', key.connection)
    .where('entity', key.entity);
}

/** `since` only moves forward: of two replicas restarting at once the later instant stays, with either column list. */
export async function restartCoverage(driver: OrmDriver, key: CoverageKey, columns: CoverageColumns, since: Date): Promise<void> {
  await driver.update().in(HISTORY_COVERAGE_TABLE).update({ since }).where('trail', key.trail).where('connection', key.connection).where('entity', key.entity).where('since', '<', since);
  await writeCoverageColumns(driver, key, columns);
}

export async function deleteCoverage(driver: OrmDriver, connection: string, entities: readonly string[]): Promise<void> {
  await driver
    .del()
    .from(HISTORY_COVERAGE_TABLE)
    .where('connection', connection)
    .whereIn('entity', [...entities]);
}

/** Retention: nothing older than `cutoff` is sure to be in the trail any more. */
export async function moveCoverage(driver: OrmDriver, trail: string, cutoff: Date): Promise<void> {
  await driver.update().in(HISTORY_COVERAGE_TABLE).update({ since: cutoff }).where('trail', trail).where('since', '<', cutoff);
}
