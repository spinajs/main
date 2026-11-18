import { DI } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';

import type { AuditFilter, AuditPinnedHead, AuditQuery, AuditReader, AuditService, AuditSubject, AuditTrail, AuditVerifyReport, StoredAuditEvent, TrailConfig } from './contracts.js';
import { AuditConfigError, AuditNotSupported } from './errors.js';
import { quoted } from './guards.js';
import { auditStore } from './stores.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const TRACE_ID = /^[0-9a-f]{32}$/;

async function readerOf(config: TrailConfig, operation: string, container: IContainer): Promise<AuditReader> {
  const store = await auditStore(config, container);
  const reader = await store.reader(config);
  if (!reader) throw new AuditNotSupported(`audit: trail ${quoted(config.name)} (store ${store.constructor.name}) cannot be read from this application (${operation})`);
  return reader;
}

/** One page of a trail by `seq`, oldest first unless `query.order` is 'desc'; `limit` defaults to 100 and is at most 1000. */
export async function listAudit(config: TrailConfig, operation: string, by: Pick<AuditFilter, 'actor' | 'subject' | 'subjectType' | 'traceId'>, query: AuditQuery = {}, container: IContainer = DI.RootContainer): Promise<readonly StoredAuditEvent[]> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new AuditConfigError(`audit: limit must be an integer from 1 to ${MAX_LIMIT}`);
  // `query.subjectType` travels in the spread; a `by` that names one wins.
  return (await readerOf(config, operation, container)).list(config, { ...query, ...by, order: query.order === 'desc' ? 'desc' : 'asc', limit });
}

export class StoreAuditTrail implements AuditTrail {
  constructor(private readonly service: AuditService, public readonly config: TrailConfig, private readonly container: IContainer = DI.RootContainer) {}

  byActor(actor: string, query?: AuditQuery): Promise<readonly StoredAuditEvent[]> {
    return listAudit(this.config, 'byActor', { actor }, query, this.container);
  }

  of(subject: AuditSubject, query?: AuditQuery): Promise<readonly StoredAuditEvent[]> {
    return listAudit(this.config, 'of', { subject }, query, this.container);
  }

  byTrace(traceId: string, query?: AuditQuery): Promise<readonly StoredAuditEvent[]> {
    if (!TRACE_ID.test(traceId)) return Promise.reject(new AuditConfigError(`audit: ${quoted(traceId)} is not a trace id`));
    return listAudit(this.config, 'byTrace', { traceId }, query, this.container);
  }

  since(seq: number, query?: AuditQuery): Promise<readonly StoredAuditEvent[]> {
    return listAudit(this.config, 'since', {}, { ...query, afterSeq: Math.max(seq, query?.afterSeq ?? seq) }, this.container);
  }

  async forget(subject: AuditSubject, source?: string): Promise<number> {
    const reader = await readerOf(this.config, 'forget', this.container);
    let total = 0;
    for await (const { connection, redacted } of reader.redactEach(this.config, subject, source)) {
      await this.service.record({ kind: 'custom', action: 'erasure', subject, data: { redacted } }, { trail: this.config.name, mode: 'confirmed', connection });
      total += redacted;
    }
    return total;
  }

  async verify(source?: string, pinned?: AuditPinnedHead): Promise<AuditVerifyReport> {
    const { name, integrity } = this.config;
    if (integrity !== 'sealed') throw new AuditNotSupported(`audit: trail ${quoted(name)} is not sealed, so it has nothing to verify (audit.trails.${name}.integrity)`);
    const reader = await readerOf(this.config, 'verify', this.container);
    if (!reader.verify) throw new AuditNotSupported(`audit: the reader ${reader.constructor.name} of trail ${quoted(name)} cannot verify seals`);
    return reader.verify(this.config, source, pinned);
  }
}
