import { AUDIT_KINDS, AUDIT_OUTCOMES } from '@spinajs/audit';
import type { AuditEvent, AuditSubject } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { QueueService } from '@spinajs/queue';

import { ArchiveAuditSink } from '../ship/archive-sink.js';
import { AuditBatchRecorded } from './event.js';

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// undefined: no subject; null: a subject that is not one.
function subjectOf(v: unknown): AuditSubject | undefined | null {
  if (v === undefined || v === null) return undefined;
  return isRecord(v) && typeof v.type === 'string' && typeof v.id === 'string' ? { type: v.type, id: v.id } : null;
}

// A message comes from another process: each event is decoded, not trusted to be a WireAuditEvent.
function fromWire(e: unknown): AuditEvent | undefined {
  if (!isRecord(e) || typeof e.id !== 'string' || typeof e.action !== 'string' || typeof e.actor !== 'string' || !isRecord(e.data)) return undefined;
  const at = new Date(text(e.at) ?? Number.NaN);
  const kind = AUDIT_KINDS.find((k) => k === e.kind);
  const outcome = AUDIT_OUTCOMES.find((o) => o === e.outcome);
  const subject = subjectOf(e.subject);
  if (Number.isNaN(at.getTime()) || kind === undefined || outcome === undefined || subject === null) return undefined;
  return {
    id: e.id,
    at,
    kind,
    action: e.action,
    subject,
    outcome,
    actor: e.actor,
    onBehalfOf: text(e.onBehalfOf),
    traceId: text(e.traceId),
    origin: text(e.origin),
    tenant: text(e.tenant),
    decisionId: text(e.decisionId),
    idempotencyKey: text(e.idempotencyKey),
    dataSubject: text(e.dataSubject),
    data: e.data,
  };
}

/** Stores one received batch in this application's archive of the trail; safe to call again with the same message. */
export async function archiveAuditBatch(message: AuditBatchRecorded): Promise<void> {
  const raw: unknown = message.Events;
  const events = Array.isArray(raw) ? raw.map(fromWire) : [undefined];
  if (typeof message.Trail !== 'string' || typeof message.Source !== 'string' || events.includes(undefined)) throw new InvalidOperation('audit: malformed AuditBatchRecorded message');
  // The sink opens its own transaction: a duplicate a concurrent delivery stored is retried there instead of aborting a transaction of ours.
  await DI.resolve(ArchiveAuditSink).deliver({ trail: message.Trail, source: message.Source, events: events.filter((e): e is AuditEvent => e !== undefined) });
}

/** For the receiving service: subscribes durably and archives every batch. */
export async function consumeAuditBatches(subscriptionId = 'audit-archive'): Promise<void> {
  const queue = await DI.resolve(QueueService);
  await queue.consume(AuditBatchRecorded, archiveAuditBatch, subscriptionId, true);
}
