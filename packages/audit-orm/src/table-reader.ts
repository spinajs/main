import { AuditReader } from '@spinajs/audit';
import type { AuditFilter, AuditPinnedHead, AuditSubject, AuditVerifyReport, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import { REDACTED_DATA, auditConnection, rowsOf, toStored } from './rows.js';
import { pruneSealed } from './seal/prune.js';
import { ARCHIVE_CLOCK_SKEW_MS, verifyTable } from './seal/verify.js';

const DELETE_CHUNK = 500;

type Select = SelectQueryBuilder<unknown>;

function scope(select: Select, filter: AuditFilter): void {
  if (filter.kinds !== undefined) select.whereIn('kind', [...filter.kinds]);
  if (filter.actions !== undefined) select.whereIn('action', [...filter.actions]);
  if (filter.subject !== undefined) select.where('subject_type', filter.subject.type).where('subject_id', filter.subject.id);
  if (filter.subjectType !== undefined) select.where('subject_type', filter.subjectType);
  if (filter.actor !== undefined) select.where('actor', filter.actor);
  if (filter.traceId !== undefined) select.where('trace_id', filter.traceId);
}

function span(select: Select, filter: AuditFilter): void {
  if (filter.afterSeq !== undefined) select.where('seq', '>', filter.afterSeq);
  if (filter.from !== undefined) select.where('at', '>=', filter.from);
  if (filter.to !== undefined) select.where('at', '<=', filter.to);
}

@Injectable(AuditReader)
export class TableAuditReader extends AuditReader {
  /** The connection that holds the events written on `source`; a table trail keeps them on `source` itself. */
  protected driver(trail: TrailConfig, source: string | undefined): OrmDriver {
    return auditConnection(source ?? trail.connection);
  }

  protected table(trail: TrailConfig): string {
    return trail.table;
  }

  /** True when the table keeps the events of several source connections apart in a `source` column, as an archive does. */
  protected hasSourceColumn(): boolean {
    return false;
  }

  /** `by` 'at' orders by time, then `seq`: what a merge of several connections by time needs. */
  async list(trail: TrailConfig, filter: AuditFilter, by: 'seq' | 'at' = 'seq'): Promise<readonly StoredAuditEvent[]> {
    if (filter.kinds?.length === 0 || filter.actions?.length === 0) return [];
    const select: Select = this.driver(trail, filter.source).select().from(this.table(trail));
    if (this.hasSourceColumn()) select.where('source', filter.source ?? trail.connection);
    scope(select, filter);
    span(select, filter);
    for (const column of by === 'at' ? ['at', 'seq'] : ['seq']) {
      if (filter.order === 'desc') select.orderByDescending(column);
      else select.orderBy(column);
    }
    return rowsOf(await select.take(filter.limit)).map(toStored);
  }

  /** Without a `source`, a table with a source column is redacted for every source. */
  async redact(trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number> {
    const update = this.driver(trail, source).update().in(this.table(trail)).update({ data: REDACTED_DATA });
    if (source !== undefined && this.hasSourceColumn()) update.where('source', source);
    const { RowsAffected } = await update.where('subject_type', subject.type).where('subject_id', subject.id).where('data', '<>', REDACTED_DATA);
    return RowsAffected;
  }

  /** Without a `source`, a table with a source column is pruned for every source. A sealed table loses whole sealed ranges only, of every source. */
  async prune(trail: TrailConfig, before: Date, source?: string): Promise<number> {
    if (trail.integrity === 'sealed') return pruneSealed(this.driver(trail, source), this.table(trail), before);
    const driver = this.driver(trail, source);
    const table = this.table(trail);
    let deleted = 0;
    // spinajs-orm-ignore ORM102: deliberate batching, one SELECT and one DELETE per DELETE_CHUNK events
    for (;;) {
      const old: Select = driver.select().from(table).columns(['seq']).where('at', '<', before);
      if (source !== undefined && this.hasSourceColumn()) old.where('source', source);
      const seqs = rowsOf(await old.orderBy('seq').take(DELETE_CHUNK)).map((r) => r.seq);
      if (seqs.length === 0) return deleted;
      deleted += (await driver.del().from(table).whereIn('seq', seqs)).RowsAffected;
      if (seqs.length < DELETE_CHUNK) return deleted;
    }
  }

  /** The chain of an archive table spans its sources, so `source` does not narrow it there. */
  async verify(trail: TrailConfig, source?: string, pinned?: AuditPinnedHead): Promise<AuditVerifyReport> {
    return { trail: trail.name, ...(await verifyTable(this.driver(trail, source), this.table(trail), { pinned, retentionDays: trail.retentionDays, clockSkewMs: this.hasSourceColumn() ? ARCHIVE_CLOCK_SKEW_MS : undefined })) };
  }
}
