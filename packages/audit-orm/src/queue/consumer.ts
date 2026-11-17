import { AUDIT_KINDS, AUDIT_OUTCOMES, AUDIT_WIDTHS, trailConfig } from '@spinajs/audit';
import type { AuditEvent, AuditSubject } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { instantFromDb } from '@spinajs/orm';
import { QueueService } from '@spinajs/queue';

import { rowsOf } from '../rows.js';
import { archiveDriver } from '../ship/archive.js';
import { ArchiveAuditReader } from '../ship/archive-reader.js';
import { ArchiveAuditSink } from '../ship/archive-sink.js';
import { AuditBatchRecorded } from './event.js';

// What `forget` records; the core has no constant for it.
const ERASURE = { kind: 'custom', action: 'erasure' } as const;
// A publisher's clock may run ahead of ours, but an event far in the future would escape retention and skew reads by time.
const MAX_AHEAD_MS = 5 * 60 * 1000;
const W = AUDIT_WIDTHS;

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => v !== null && typeof v === 'object' && !Array.isArray(v);
const sized = (v: unknown, width: number): v is string => typeof v === 'string' && v.length <= width;
// null: present but not a string that fits, which refuses the message.
const optional = (v: unknown, width: number): string | undefined | null => (v === undefined ? undefined : sized(v, width) ? v : null);

// undefined: no subject; null: a subject that is not one.
function subjectOf(v: unknown): AuditSubject | undefined | null {
  if (v === undefined || v === null) return undefined;
  return isRecord(v) && sized(v.type, W.subject_type) && sized(v.id, W.subject_id) ? { type: v.type, id: v.id } : null;
}

// Exactly the text the sink writes (`toISOString()`), and not far ahead of this clock.
function instantOf(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const at = new Date(v);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== v || at.getTime() > Date.now() + MAX_AHEAD_MS) return undefined;
  return at;
}

type OptionalFields = Pick<AuditEvent, 'onBehalfOf' | 'traceId' | 'origin' | 'tenant' | 'decisionId' | 'idempotencyKey' | 'dataSubject'>;

function optionalFields(e: Readonly<Record<string, unknown>>): OptionalFields | undefined {
  const onBehalfOf = optional(e.onBehalfOf, W.on_behalf_of);
  const traceId = optional(e.traceId, W.trace_id);
  const origin = optional(e.origin, W.origin);
  const tenant = optional(e.tenant, W.tenant);
  const decisionId = optional(e.decisionId, W.decision_id);
  const idempotencyKey = optional(e.idempotencyKey, W.idempotency_key);
  const dataSubject = optional(e.dataSubject, W.data_subject);
  if ([onBehalfOf, traceId, origin, tenant, decisionId, idempotencyKey, dataSubject].includes(null)) return undefined;
  return { onBehalfOf: onBehalfOf ?? undefined, traceId: traceId ?? undefined, origin: origin ?? undefined, tenant: tenant ?? undefined, decisionId: decisionId ?? undefined, idempotencyKey: idempotencyKey ?? undefined, dataSubject: dataSubject ?? undefined };
}

// A message comes from another process: each event is decoded, not trusted to be a WireAuditEvent, and refused whole
// when a field could not be stored the same way on every dialect.
function fromWire(e: unknown): AuditEvent | undefined {
  if (!isRecord(e) || !sized(e.id, W.id) || !sized(e.action, W.action) || !sized(e.actor, W.actor) || !isRecord(e.data)) return undefined;
  const at = instantOf(e.at);
  const kind = AUDIT_KINDS.find((k) => k === e.kind);
  const outcome = AUDIT_OUTCOMES.find((o) => o === e.outcome);
  const subject = subjectOf(e.subject);
  const rest = optionalFields(e);
  if (at === undefined || kind === undefined || outcome === undefined || subject === null || rest === undefined) return undefined;
  return { ...rest, id: e.id, at, kind, action: e.action, subject, outcome, actor: e.actor, data: e.data };
}

const keyOf = (type: unknown, id: unknown): string => JSON.stringify([type, id]);

/**
 * Blanks the subjects of a stored batch that this service erased at or after one of their events' `at`: such an event
 * was still buffered or in flight when `forget` ran here. One select per batch.
 */
async function redactErased(trailName: string, events: readonly AuditEvent[]): Promise<void> {
  const subjects = events.filter((e) => e.action !== ERASURE.action || e.kind !== ERASURE.kind).flatMap((e) => (e.subject === undefined ? [] : [{ subject: e.subject, at: e.at.getTime() }]));
  if (subjects.length === 0) return;
  const trail = trailConfig(trailName);
  const select = archiveDriver(trail)
    .select()
    .from(trail.table)
    .columns(['subject_type', 'subject_id', 'at'])
    .whereIn('subject_type', [...new Set(subjects.map((s) => s.subject.type))])
    .whereIn('subject_id', [...new Set(subjects.map((s) => s.subject.id))])
    .where('action', ERASURE.action)
    .where('kind', ERASURE.kind);
  const erasedAt = new Map<string, number>();
  for (const row of rowsOf(await select)) {
    const at = instantFromDb(row.at)?.toMillis() ?? Number.NaN;
    const key = keyOf(row.subject_type, row.subject_id);
    if (at > (erasedAt.get(key) ?? Number.NEGATIVE_INFINITY)) erasedAt.set(key, at);
  }
  const erased = new Map(subjects.filter((s) => s.at <= (erasedAt.get(keyOf(s.subject.type, s.subject.id)) ?? Number.NEGATIVE_INFINITY)).map((s) => [keyOf(s.subject.type, s.subject.id), s.subject]));
  const reader = await DI.resolve(ArchiveAuditReader);
  for (const subject of erased.values()) await reader.redact(trail, subject);
}

/** Stores one received batch in this application's archive of the trail; safe to call again with the same message. */
export async function archiveAuditBatch(message: AuditBatchRecorded): Promise<void> {
  const raw: unknown = message.Events;
  const events = Array.isArray(raw) ? raw.map(fromWire) : [undefined];
  if (typeof message.Trail !== 'string' || typeof message.Source !== 'string' || events.includes(undefined)) throw new InvalidOperation('audit: malformed AuditBatchRecorded message');
  const decoded = events.filter((e): e is AuditEvent => e !== undefined);
  // The sink opens its own transaction: a duplicate a concurrent delivery stored is retried there instead of aborting a transaction of ours.
  await DI.resolve(ArchiveAuditSink).deliver({ trail: message.Trail, source: message.Source, events: decoded });
  // After the store: a redaction that fails fails the message, and its redelivery stores nothing twice and redacts again.
  await redactErased(message.Trail, decoded);
}

/** For the receiving service: subscribes durably and archives every batch. */
export async function consumeAuditBatches(subscriptionId = 'audit-archive'): Promise<void> {
  const queue = await DI.resolve(QueueService);
  await queue.consume(AuditBatchRecorded, archiveAuditBatch, subscriptionId, true);
}
