import { AuthzConfigError, CHANGE_KINDS, ChangeLog, authzStorage, currentPrincipal, principalKey } from '@spinajs/authz';
import type { ChangeEntry, ChangeKind, ChangeOp, ChangeQuery, ChangeRecord, ResourceType } from '@spinajs/authz';
import { Injectable, Singleton } from '@spinajs/di';
import type { ISelectQueryBuilder } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { recordDriver, selectFrom } from '../records.js';
import { ChangeLogRecord } from './record.js';
import { CHANGE_LOG_TABLE, CHANGE_LOG_WIDTHS } from './table.js';

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;
// Keeps one INSERT within the row and bind-parameter limits of every driver.
const INSERT_CHUNK = 100;
const OPS: readonly string[] = ['add', 'remove', 'put'];
const TRACE_ID = /^[0-9a-f]{32}$/;

/** The W3C trace id http's RequestId puts on the request store authz shares with it. */
function ambientTraceId(): string | null {
  const id = authzStorage().getStore()?.traceId;
  return typeof id === 'string' && TRACE_ID.test(id) ? id : null;
}

function checkEntry(e: ChangeEntry, i: number): void {
  const where = `DbChangeLog.append: entry ${i}`;
  if (!(CHANGE_KINDS as readonly string[]).includes(e?.kind)) throw new AuthzConfigError(`${where}: unknown kind ${JSON.stringify(e?.kind)}`);
  if (!OPS.includes(e.op)) throw new AuthzConfigError(`${where}: unknown op ${JSON.stringify(e.op)}`);
  if (typeof e.key !== 'string' || e.key === '' || e.key.length > CHANGE_LOG_WIDTHS.key) throw new AuthzConfigError(`${where}: the key must be a non-empty string of at most ${CHANGE_LOG_WIDTHS.key} characters`);
}

function parsePayload(r: ChangeLogRecord): unknown {
  if (r.payload === null || r.payload === undefined) return null;
  try {
    return JSON.parse(r.payload) as unknown;
  } catch (err) {
    throw new AuthzConfigError(`${CHANGE_LOG_TABLE} row ${String(r.seq)}: payload is not JSON`, { cause: err });
  }
}

const toRecord = (r: ChangeLogRecord): ChangeRecord => ({
  seq: Number(r.seq),
  at: r.at.toJSDate(),
  kind: r.kind as ChangeKind,
  op: r.op as ChangeOp,
  key: r.key,
  payload: parsePayload(r),
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

  covers(kind: ChangeKind, _resourceType?: ResourceType): boolean {
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

  private async select(query: ChangeQuery | undefined, narrow: (q: ISelectQueryBuilder<ChangeLogRecord[]>) => void): Promise<readonly ChangeRecord[]> {
    const limit = limitOf(query);
    if (limit === 0 || query?.kinds?.length === 0) return [];
    const q = selectFrom(ChangeLogRecord);
    narrow(q);
    if (query?.after !== undefined) q.where('seq', '>', query.after);
    if (query?.kinds !== undefined) q.whereIn('kind', [...query.kinds]);
    q.orderBy('seq').take(limit);
    return (await q).map(toRecord);
  }
}
