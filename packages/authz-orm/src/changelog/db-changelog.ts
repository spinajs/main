import { AuthzConfigError, CHANGE_KINDS, ChangeLog, ambientTraceId, currentPrincipal, principalKey, thrownError } from '@spinajs/authz';
import type { ChangeEntry, ChangeKind, ChangeOp, ChangeQuery, ChangeRecord, ResourceType } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';
import type { ISelectQueryBuilder, OrmDriver } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { ormLog } from '../host.js';
import { recordDriver, selectFrom } from '../records.js';
import { classesOf, entryOf, registeredTypes } from '../registry.js';
import { HorizonRecord, horizonType, recordCoverage, restartCoverage } from './horizon.js';
import { ChangeLogRecord } from './record.js';
import { CHANGE_LOG_TABLE, CHANGE_LOG_WIDTHS } from './table.js';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;
// Keeps one INSERT within the row and bind-parameter limits of every driver.
const INSERT_CHUNK = 100;
const OPS: readonly string[] = ['add', 'remove', 'put'];
// Keeps one IN list within the bind-parameter limits of every driver.
const KEY_CHUNK = 500;

let columnHook = false;

/** The column middleware calls it once it is registered: the `column` kind is covered from then on. */
export function columnChangesRecorded(): void {
  columnHook = true;
}

/** Every model of `type` records its relation columns; an unknown type has none to replay from. */
function columnsCovered(type: ResourceType): boolean {
  const models = classesOf(type);
  return models.length > 0 && models.every((m) => entryOf(m)?.changelog !== false);
}

/**
 * How far apart two instants of `authz_change_log.at` (and of `authz_decision_log.at` and `logged_at`) may be and
 * still read back alike on the driver's dialect. MySQL's DATETIME keeps whole seconds; an unknown driver gets the
 * conservative second.
 */
export function changeLogPrecisionMs(driver: OrmDriver): number {
  const name = driver.Options.Driver;
  return name === 'orm-driver-sqlite' || name === 'orm-driver-postgres' ? 1 : 1000;
}

function checkEntry(e: ChangeEntry, i: number): void {
  const where = `DbChangeLog.append: entry ${i}`;
  if (!(CHANGE_KINDS as readonly string[]).includes(e?.kind)) throw new AuthzConfigError(`${where}: unknown kind ${JSON.stringify(e?.kind)}`);
  if (!OPS.includes(e.op)) throw new AuthzConfigError(`${where}: unknown op ${JSON.stringify(e.op)}`);
  if (typeof e.key !== 'string' || e.key === '' || e.key.length > CHANGE_LOG_WIDTHS.key) throw new AuthzConfigError(`${where}: the key must be a non-empty string of at most ${CHANGE_LOG_WIDTHS.key} characters`);
}

function parseJson(r: ChangeLogRecord, column: 'payload' | 'before'): unknown {
  const text = r[column];
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new AuthzConfigError(`${CHANGE_LOG_TABLE} row ${String(r.seq)}: ${column} is not JSON`, { cause: err });
  }
}

const toRecord = (r: ChangeLogRecord): ChangeRecord => ({
  seq: Number(r.seq),
  at: r.at.toJSDate(),
  kind: r.kind as ChangeKind,
  op: r.op as ChangeOp,
  key: r.key,
  payload: parseJson(r, 'payload'),
  before: parseJson(r, 'before'),
  actor: r.actor ?? null,
  traceId: r.trace_id ?? null,
});

function limitOf(q: ChangeQuery | undefined): number {
  const limit = q?.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_LIMIT) throw new AuthzConfigError(`ChangeLog: limit must be an integer from 0 to ${MAX_LIMIT}`);
  return limit;
}

/**
 * `ChangeLog` over `authz_change_log` on the `authz` connection (migration AuthzChangeLog_2026_11_04_00_00_00). It
 * appends only inside a transaction on that connection: the ORM runs the insert on the ambient transaction, so a
 * change commits or rolls back with the store write it records.
 */
@Singleton()
@Injectable(ChangeLog)
export class DbChangeLog extends ChangeLog {
  private readonly tracked = new Set<ChangeKind>();
  private coverageWarned = false;

  covers(kind: ChangeKind, resourceType?: ResourceType): boolean {
    if (kind === 'column') return columnHook && (resourceType === undefined || columnsCovered(resourceType));
    return this.tracked.has(kind);
  }

  track(kind: ChangeKind): void {
    this.tracked.add(kind);
  }

  async append(entries: readonly ChangeEntry[]): Promise<void> {
    if (entries.length === 0) return;
    entries.forEach(checkEntry);
    const driver = recordDriver(ChangeLogRecord);
    if (driver.CurrentTransaction === undefined) {
      throw new AuthzConfigError(`DbChangeLog.append: a change is written in the transaction of the write it records, and none is in scope on connection ${JSON.stringify(driver.Options.Name)}`);
    }
    const now = new Date();
    const actor = principalKey(currentPrincipal());
    const traceId = ambientTraceId();
    const rows = entries.map((e) => ({
      at: DateTime.fromJSDate(e.at ?? now),
      kind: e.kind,
      op: e.op,
      key: e.key,
      payload: e.payload === undefined ? null : JSON.stringify(e.payload),
      actor: (e.actor ?? actor).slice(0, CHANGE_LOG_WIDTHS.actor),
      trace_id: traceId,
    }));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) await ChangeLogRecord.insert(rows.slice(i, i + INSERT_CHUNK));
  }

  async since(seq: number, query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return this.select(query, (q) => {
      q.where('seq', '>', seq);
    });
  }

  async until(at: Date, query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return this.select(query, (q) => {
      q.where('at', '<=', DateTime.fromJSDate(at));
    });
  }

  async afterInstant(at: Date, query?: ChangeQuery): Promise<readonly ChangeRecord[]> {
    return this.select(query, (q) => {
      q.where('at', '>', DateTime.fromJSDate(at));
    });
  }

  async latest(kind: ChangeKind, keys: readonly string[], at?: Date): Promise<ReadonlyMap<string, ChangeRecord>> {
    const out = new Map<string, ChangeRecord>();
    const unique = [...new Set(keys)];
    // spinajs-orm-ignore ORM102: deliberate batching, one query per 500 keys
    for (let i = 0; i < unique.length; i += KEY_CHUNK) {
      const heads = selectFrom(ChangeLogRecord).onPrimary().max('seq', 'seq').where('kind', kind).whereIn('key', unique.slice(i, i + KEY_CHUNK)).groupBy('key');
      if (at !== undefined) heads.where('at', '<=', DateTime.fromJSDate(at));
      const seqs = (await heads).map((r) => Number(r.seq)).filter((n) => Number.isSafeInteger(n));
      if (seqs.length === 0) continue;
      for (const r of await selectFrom(ChangeLogRecord).onPrimary().whereIn('seq', seqs)) out.set(r.key, toRecord(r));
    }
    return out;
  }

  /** Reads the horizon only: what this process tracks says nothing of the writes before it started. */
  async coveredSince(kind: ChangeKind, resourceType?: ResourceType): Promise<Date | undefined> {
    const row = (await selectFrom(HorizonRecord).onPrimary().where('kind', kind).where('resource_type', horizonType(kind, resourceType)).first()) as HorizonRecord | undefined;
    return row?.since.toJSDate();
  }

  /**
   * Inside a transaction the restart waits for the commit: a write that rolls back escaped nothing, and one that
   * commits becomes visible only then. Never rejects, so the write that escaped does not fail over its signal.
   */
  async lost(kind: ChangeKind, resourceType?: ResourceType, reason?: string): Promise<void> {
    const fields = { kind, resourceType: resourceType ?? '*', reason: reason ?? 'unknown' };
    const fail = (e: unknown) => ormLog().error({ ...fields, error: thrownError(e) }, 'authz-orm: a ${kind} write of ${resourceType} escaped the changelog (${reason}) and its coverage could not be restarted; replays before now may read a wrong state');
    const restart = async (): Promise<void> => {
      try {
        await restartCoverage(kind, resourceType, new Date());
      } catch (e) {
        fail(e);
      }
    };
    try {
      const driver = recordDriver(HorizonRecord);
      if (driver.CurrentTransaction !== undefined) await driver.afterCommit(restart);
      else await restart();
    } catch (e) {
      fail(e);
    }
  }

  /**
   * Records in the horizon what this process writes to the log: the kinds its stores track and, while the column
   * middleware is loaded, the `column` kind of every `@AccessResource` type whose models all keep the changelog.
   * Best effort: a deploy may boot before the migration ran, so a failure warns once and coverage starts at the first
   * boot that finds the table.
   */
  async recordBootCoverage(now: Date = new Date()): Promise<void> {
    const types = registeredTypes();
    const columns = columnHook ? types.filter(columnsCovered) : [];
    const optedOut = types.filter((t) => classesOf(t).some((m) => entryOf(m)?.changelog === false));
    try {
      await recordCoverage([...this.tracked], columns, optedOut, now);
    } catch (e) {
      if (this.coverageWarned) return;
      this.coverageWarned = true;
      ormLog().warn({ error: thrownError(e) }, 'authz-orm: authz_change_log_horizon could not be written, so replays cannot tell since when the changelog is complete; run the authz migrations');
    }
  }

  private async select(query: ChangeQuery | undefined, narrow: (q: ISelectQueryBuilder<ChangeLogRecord[]>) => void): Promise<readonly ChangeRecord[]> {
    const limit = limitOf(query);
    if (limit === 0 || query?.kinds?.length === 0) return [];
    const q = selectFrom(ChangeLogRecord).onPrimary();
    narrow(q);
    if (query?.after !== undefined) q.where('seq', '>', query.after);
    if (query?.kinds !== undefined) q.whereIn('kind', [...query.kinds]);
    q.orderBy('seq').take(limit);
    return (await q).map(toRecord);
  }
}
