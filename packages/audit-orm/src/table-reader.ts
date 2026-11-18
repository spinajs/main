import { AuditReader, AuditWriteFailed } from '@spinajs/audit';
import type { AuditFilter, AuditPinnedHead, AuditRedaction, AuditSubject, AuditVerifyReport, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { Injectable } from '@spinajs/di';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import { ERASURE_ACTION, REDACTED_DATA, auditConnection, rowsOf, toStored } from './rows.js';
import { pruneSealed } from './seal/prune.js';
import { ARCHIVE_CLOCK_SKEW_MS, verifyTable } from './seal/verify.js';
import { distinctConnections } from './ship/services.js';
import { trailTableOn } from './trail-tables.js';

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
  redact(trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number> {
    return this.redactOn(this.driver(trail, source), trail, subject, source);
  }

  /**
   * Without a `source`, a table without a source column is redacted on every connection that holds it, the trail's own
   * first: transactional events sit on the connection of each audited write. Every connection is looked at before
   * anything is blanked. Another connection gets an erasure record where the subject has a row, so running `forget`
   * again writes a record whose write failed the first time.
   */
  override async *redactEach(trail: TrailConfig, subject: AuditSubject, source?: string): AsyncGenerator<AuditRedaction> {
    if (source !== undefined || this.hasSourceColumn()) {
      yield* super.redactEach(trail, subject, source);
      return;
    }
    const own = this.driver(trail, undefined);
    const others: OrmDriver[] = [];
    for (const driver of distinctConnections()) {
      if (driver !== own && (await this.holdsTable(driver, trail))) others.push(driver);
    }
    yield { connection: undefined, redacted: await this.redactOn(own, trail, subject) };
    for (const driver of others) {
      const redacted = await this.redactOn(driver, trail, subject);
      if (redacted > 0 || (await this.holds(driver, trail, subject))) yield { connection: driver.Options.Name, redacted };
    }
  }

  private async holdsTable(driver: OrmDriver, trail: TrailConfig): Promise<boolean> {
    try {
      return (await trailTableOn(driver, this.table(trail))) === 'trail';
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new AuditWriteFailed(`audit: forget on trail ${JSON.stringify(trail.name)} could not look for table ${this.table(trail)} on connection ${JSON.stringify(driver.Options.Name)}, so nothing was erased: ${why}`, err);
    }
  }

  private async holds(driver: OrmDriver, trail: TrailConfig, subject: AuditSubject): Promise<boolean> {
    const select: Select = driver.select().from(this.table(trail)).columns(['seq']).where('subject_type', subject.type).where('subject_id', subject.id);
    return rowsOf(await select.take(1)).length > 0;
  }

  private async redactOn(driver: OrmDriver, trail: TrailConfig, subject: AuditSubject, source?: string): Promise<number> {
    const update = driver.update().in(this.table(trail)).update({ data: REDACTED_DATA });
    if (source !== undefined && this.hasSourceColumn()) update.where('source', source);
    const { RowsAffected } = await update.where('subject_type', subject.type).where('subject_id', subject.id).where('action', '<>', ERASURE_ACTION).where('data', '<>', REDACTED_DATA);
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
