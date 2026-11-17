import { AUDIT_KINDS, AUDIT_OUTCOMES, AUDIT_WIDTHS, trailConfig } from '@spinajs/audit';
import type { AuditEvent, AuditSubject, TrailConfig } from '@spinajs/audit';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { instantFromDb } from '@spinajs/orm';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';
import { QueueService } from '@spinajs/queue';

import { isTableTrail } from '../own-tables.js';
import { REDACTED_DATA, auditConnection, rowsOf } from '../rows.js';
import { archiveDriver } from '../ship/archive.js';
import { ArchiveAuditSink } from '../ship/archive-sink.js';
import { OutboxAuditStore } from '../ship/outbox-store.js';
import { AUDIT_OUTBOX_TABLE } from '../ship/table.js';
import { AuditBatchRecorded } from './event.js';

// What `forget` records; the core has no constant for it.
const ERASURE = { kind: 'custom', action: 'erasure' } as const;
// A publisher's clock may run ahead of ours, but an event far in the future would escape retention and skew reads by time.
const MAX_AHEAD_MS = 5 * 60 * 1000;
const MALFORMED = 'audit: malformed AuditBatchRecorded message';
const ID_CHUNK = 500;
const W = AUDIT_WIDTHS;

type Wire = Readonly<Record<string, unknown>>;

class Malformed extends Error {}

const isRecord = (v: unknown): v is Wire => v !== null && typeof v === 'object' && !Array.isArray(v);
const sized = (v: unknown, width: number): v is string => typeof v === 'string' && v.length <= width;

function text(v: unknown, field: string, width: number): string {
  if (!sized(v, width)) throw new Malformed(`${field} is not a string of at most ${width} characters`);
  return v;
}

const optional = (v: unknown, field: string, width: number): string | undefined => (v === undefined ? undefined : text(v, field, width));

function oneOf<T extends string>(allowed: readonly T[], v: unknown, field: string): T {
  const found = allowed.find((a) => a === v);
  if (found === undefined) throw new Malformed(`${field} is not one of ${allowed.join(', ')}`);
  return found;
}

function subjectOf(v: unknown): AuditSubject | undefined {
  if (v === undefined || v === null) return undefined;
  if (isRecord(v) && sized(v.type, W.subject_type) && sized(v.id, W.subject_id)) return { type: v.type, id: v.id };
  throw new Malformed(`subject is not a type of at most ${W.subject_type} and an id of at most ${W.subject_id} characters`);
}

// Exactly the text the sink writes (`toISOString()`), and not far ahead of this clock.
function instantOf(v: unknown): Date {
  const at = new Date(typeof v === 'string' ? v : Number.NaN);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== v) throw new Malformed('at is not the toISOString() text of an instant');
  if (at.getTime() > Date.now() + MAX_AHEAD_MS) throw new Malformed("at is more than 5 minutes ahead of this service's clock");
  return at;
}

function decode(e: Wire): AuditEvent {
  const data = e.data;
  if (!isRecord(data)) throw new Malformed('data is not an object');
  return {
    id: text(e.id, 'id', W.id),
    at: instantOf(e.at),
    kind: oneOf(AUDIT_KINDS, e.kind, 'kind'),
    action: text(e.action, 'action', W.action),
    subject: subjectOf(e.subject),
    outcome: oneOf(AUDIT_OUTCOMES, e.outcome, 'outcome'),
    actor: text(e.actor, 'actor', W.actor),
    onBehalfOf: optional(e.onBehalfOf, 'onBehalfOf', W.on_behalf_of),
    traceId: optional(e.traceId, 'traceId', W.trace_id),
    origin: optional(e.origin, 'origin', W.origin),
    tenant: optional(e.tenant, 'tenant', W.tenant),
    decisionId: optional(e.decisionId, 'decisionId', W.decision_id),
    idempotencyKey: optional(e.idempotencyKey, 'idempotencyKey', W.idempotency_key),
    dataSubject: optional(e.dataSubject, 'dataSubject', W.data_subject),
    data,
  };
}

// A message comes from another process: each event is decoded, not trusted to be a WireAuditEvent, and the message is
// refused whole, naming the first event and field, when a field could not be stored the same way on every dialect.
function fromWire(e: unknown, index: number): AuditEvent {
  const label = isRecord(e) && sized(e.id, W.id) ? `event ${e.id}` : `event #${index}`;
  try {
    if (!isRecord(e)) throw new Malformed('not an object');
    return decode(e);
  } catch (err) {
    if (err instanceof Malformed) throw new InvalidOperation(`${MALFORMED}: ${label}: ${err.message}`);
    throw err;
  }
}

const keyOf = (type: unknown, id: unknown): string => JSON.stringify([type, id]);
const isErasure = (e: AuditEvent): boolean => e.action === ERASURE.action && e.kind === ERASURE.kind;

function erasuresOf(driver: OrmDriver, table: string, subjects: readonly AuditSubject[]): SelectQueryBuilder<unknown> {
  return driver
    .select()
    .from(table)
    .columns(['subject_type', 'subject_id', 'at'])
    .whereIn('subject_type', [...new Set(subjects.map((s) => s.type))])
    .whereIn('subject_id', [...new Set(subjects.map((s) => s.id))])
    .where('action', ERASURE.action)
    .where('kind', ERASURE.kind);
}

// This service's own `forget` buffers its erasure record on the trail's connection until its shipper archives it.
async function bufferedErasures(trail: TrailConfig, subjects: readonly AuditSubject[]): Promise<unknown> {
  if (!isTableTrail(trail, OutboxAuditStore)) return [];
  const driver = auditConnection(trail.connection);
  try {
    return await erasuresOf(driver, AUDIT_OUTBOX_TABLE, subjects).where('trail', trail.name);
  } catch (err) {
    if (await driver.schema().tableExists(AUDIT_OUTBOX_TABLE)) throw err;
    return [];
  }
}

/** The latest erasure `at` of each subject, in the archive or still in this service's buffer. */
async function erasedAt(trail: TrailConfig, subjects: readonly AuditSubject[]): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  const archived: unknown = await erasuresOf(archiveDriver(trail), trail.table, subjects);
  for (const row of [...rowsOf(archived), ...rowsOf(await bufferedErasures(trail, subjects))]) {
    const at = instantFromDb(row.at)?.toMillis() ?? Number.NaN;
    const key = keyOf(row.subject_type, row.subject_id);
    if (at > (latest.get(key) ?? Number.NEGATIVE_INFINITY)) latest.set(key, at);
  }
  return latest;
}

// `data_hash` is kept, as `redact` keeps it, so a seal over these rows still verifies.
async function blankIds(driver: OrmDriver, table: string, ids: readonly string[]): Promise<void> {
  // spinajs-orm-ignore ORM102: deliberate batching, one UPDATE per ID_CHUNK ids
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    await driver
      .update()
      .in(table)
      .update({ data: REDACTED_DATA })
      .whereIn('id', ids.slice(i, i + ID_CHUNK))
      .where('data', '<>', REDACTED_DATA);
  }
}

/**
 * Blanks what an erasure covers that `forget` could not reach: arriving events of a subject erased at or after their `at`
 * (they were buffered or in flight when `forget` ran), and, for an arriving erasure, the archived events of its subject
 * up to its `at` in every source. Erasure records keep their payload.
 */
async function blankErased(trailName: string, events: readonly AuditEvent[]): Promise<void> {
  const trail = trailConfig(trailName);
  const driver = archiveDriver(trail);
  const arriving = events.filter((e) => !isErasure(e) && e.subject !== undefined);
  if (arriving.length > 0) {
    const latest = await erasedAt(
      trail,
      arriving.flatMap((e) => (e.subject === undefined ? [] : [e.subject])),
    );
    const covered = arriving.filter((e) => e.at.getTime() <= (latest.get(keyOf(e.subject?.type, e.subject?.id)) ?? Number.NEGATIVE_INFINITY));
    await blankIds(
      driver,
      trail.table,
      covered.map((e) => e.id),
    );
  }
  const erasures = events.flatMap((e) => (isErasure(e) && e.subject !== undefined ? [{ subject: e.subject, at: e.at }] : []));
  // spinajs-orm-ignore ORM102: one UPDATE per erasure in the batch, which are rare
  for (const { subject, at } of erasures) {
    await driver.update().in(trail.table).update({ data: REDACTED_DATA }).where('subject_type', subject.type).where('subject_id', subject.id).where('at', '<=', at).where('action', '<>', ERASURE.action).where('data', '<>', REDACTED_DATA);
  }
}

/** Stores one received batch in this application's archive of the trail; safe to call again with the same message. */
export async function archiveAuditBatch(message: AuditBatchRecorded): Promise<void> {
  if (typeof message.Trail !== 'string') throw new InvalidOperation(`${MALFORMED}: Trail is not a string`);
  if (typeof message.Source !== 'string') throw new InvalidOperation(`${MALFORMED}: Source is not a string`);
  const raw: unknown = message.Events;
  if (!Array.isArray(raw)) throw new InvalidOperation(`${MALFORMED}: Events is not an array`);
  const events = raw.map(fromWire);
  // The sink opens its own transaction: a duplicate a concurrent delivery stored is retried there instead of aborting a transaction of ours.
  await DI.resolve(ArchiveAuditSink).deliver({ trail: message.Trail, source: message.Source, events });
  // After the store: a blanking that fails fails the message, and its redelivery stores nothing twice and blanks again.
  await blankErased(message.Trail, events);
}

/** For the receiving service: subscribes durably and archives every batch. */
export async function consumeAuditBatches(subscriptionId = 'audit-archive'): Promise<void> {
  const queue = await DI.resolve(QueueService);
  await queue.consume(AuditBatchRecorded, archiveAuditBatch, subscriptionId, true);
}
