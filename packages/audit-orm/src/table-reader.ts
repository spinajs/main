import { AuditReader } from '@spinajs/audit';
import type { AuditFilter, AuditSubject, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import { REDACTED_DATA, auditConnection, rowsOf, toStored } from './rows.js';

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

  async list(trail: TrailConfig, filter: AuditFilter): Promise<readonly StoredAuditEvent[]> {
    if (filter.kinds?.length === 0 || filter.actions?.length === 0) return [];
    const select: Select = this.driver(trail, filter.source).select().from(this.table(trail));
    if (this.hasSourceColumn()) select.where('source', filter.source ?? trail.connection);
    scope(select, filter);
    span(select, filter);
    if (filter.order === 'desc') select.orderByDescending('seq');
    else select.orderBy('seq');
    return rowsOf(await select.take(filter.limit)).map(toStored);
  }

  async redact(trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number> {
    const update = this.driver(trail, source).update().in(this.table(trail)).update({ data: REDACTED_DATA });
    if (this.hasSourceColumn()) update.where('source', source ?? trail.connection);
    const { RowsAffected } = await update.where('subject_type', subject.type).where('subject_id', subject.id).where('data', '<>', REDACTED_DATA);
    return RowsAffected;
  }

  /** Without a `source`, a table with a source column is pruned for every source. */
  async prune(trail: TrailConfig, before: Date, source?: string): Promise<number> {
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
}
