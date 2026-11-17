import { AuditConfigError, AuditEventSink, AuditReader, AuditWriteFailed } from '@spinajs/audit';
import type { AuditBatch, AuditSubject, StoredAuditEvent, TrailConfig } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import type { OrmDriver } from '@spinajs/orm';

import { auditConnection } from '../rows.js';
import { oldestBuffered, removeBlank, removeBuffered } from './outbox.js';
import { distinctConnections, namedService } from './services.js';
import { AUDIT_OUTBOX_TABLE } from './table.js';
import { shippingTrails } from './trails.js';

const DEFAULT_BATCH = 200;
// Keeps a batch under the bind limit of every driver: the guarded delete binds the seq and the id of each event (MSSQL 2100; SQLite 32766 since 3.32).
const MAX_BATCH = 500;
const DEFAULT_MAX_BATCHES = 50;
const DEFAULT_DELIVER_TIMEOUT_MS = 30000;
const DEFAULT_RUN_BUDGET_MS = 300000;

export interface ShipFailure {
  readonly trail: string;
  readonly connection: string;
}

export interface ShipResult {
  readonly shipped: number;
  readonly failed: readonly ShipFailure[];
}

export interface ShipOptions {
  readonly trail?: string;
  readonly connection?: string;
}

interface ShipLimits {
  readonly batchSize: number;
  readonly maxBatches: number;
  readonly deliverTimeoutMs: number;
  readonly stopAt: number;
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback);
const log = (): Log => DI.resolve(Log, ['audit-ship']);

function shipLimits(): ShipLimits {
  const raw: unknown = DI.get(Configuration)?.get<unknown>(['audit', 'ship']);
  const cfg = isRecord(raw) ? raw : {};
  return { batchSize: Math.min(positive(cfg.batchSize, DEFAULT_BATCH), MAX_BATCH), maxBatches: positive(cfg.maxBatches, DEFAULT_MAX_BATCHES), deliverTimeoutMs: positive(cfg.deliverTimeoutMs, DEFAULT_DELIVER_TIMEOUT_MS), stopAt: Date.now() + positive(cfg.runBudgetMs, DEFAULT_RUN_BUDGET_MS) };
}

/** The connections that hold audit_outbox; `only` narrows to one name. A connection that cannot answer is handed to `unreachable`, or, without it, fails the call. */
export async function bufferConnections(only?: string, unreachable?: (connection: string, error: unknown) => void): Promise<OrmDriver[]> {
  const candidates = only === undefined ? distinctConnections() : [auditConnection(only)];
  const found: OrmDriver[] = [];
  for (const driver of candidates) {
    try {
      if (await driver.schema().tableExists(AUDIT_OUTBOX_TABLE)) found.push(driver);
    } catch (err) {
      if (!unreachable) throw err;
      unreachable(driver.Options.Name, err);
    }
  }
  return found;
}

function sinkOf(trail: TrailConfig): Promise<AuditEventSink> {
  if (trail.sink === undefined) return Promise.reject(new AuditConfigError(`audit: trail ${JSON.stringify(trail.name)} uses OutboxAuditStore but names no sink (audit.trails.${trail.name}.sink)`));
  return namedService(AuditEventSink, trail.sink, `audit.trails.${trail.name}.sink`);
}

// A sink that never settles would hold the run open, and with overlap 'skip' stop shipping for every trail.
async function deliverBy(sink: AuditEventSink, batch: AuditBatch, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AuditWriteFailed(`audit: delivering ${batch.events.length} event(s) of trail ${JSON.stringify(batch.trail)} from connection ${JSON.stringify(batch.source)} did not finish within ${ms} ms`)), ms);
  });
  try {
    await Promise.race([sink.deliver(batch), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// These events were erased before their delivery returned: a delivery of them may have brought the destination the payload the erasure removed.
async function redactShipped(trail: TrailConfig, source: string, subjects: readonly AuditSubject[]): Promise<void> {
  const unique = [...new Map(subjects.map((s) => [JSON.stringify([s.type, s.id]), s])).values()];
  if (trail.reader === undefined) {
    log().error({ trail: trail.name, connection: source, subjects: unique.map((s) => `${s.type}:${s.id}`).join(', ') }, 'audit: trail ${trail} shipped events from ${connection} that were erased during the delivery, and has no reader to redact them: the destination may hold an erased payload of ${subjects}');
    return;
  }
  const reader = await namedService(AuditReader, trail.reader, `audit.trails.${trail.name}.reader`);
  for (const subject of unique) await reader.redact(trail, subject, source);
}

// Removed only after the redaction returned, so a failed one is tried again with the next delivery of these rows.
async function redactBlank(driver: OrmDriver, trail: TrailConfig, blank: readonly StoredAuditEvent[]): Promise<void> {
  if (blank.length === 0) return;
  try {
    await redactShipped(
      trail,
      driver.Options.Name,
      blank.flatMap((e) => (e.subject === undefined ? [] : [e.subject])),
    );
  } catch (error) {
    log().error({ error, trail: trail.name, connection: driver.Options.Name }, 'audit: redacting the destination of trail ${trail} for events erased before their delivery from ${connection} returned failed; they stay buffered and are redacted again on the next run');
    throw error;
  }
  await removeBlank(driver, blank);
}

async function drain(driver: OrmDriver, trail: TrailConfig, limits: ShipLimits, progress: { shipped: number }): Promise<void> {
  const sink = await sinkOf(trail);
  const source = driver.Options.Name;
  // spinajs-orm-ignore ORM102: deliberate batching, one SELECT, one delivery and one DELETE per batch
  for (let i = 0; i < limits.maxBatches && Date.now() < limits.stopAt; i += 1) {
    const batch = await oldestBuffered(driver, trail.name, limits.batchSize);
    if (batch.length === 0) break;
    await deliverBy(sink, { trail: trail.name, source, events: batch.map((b) => b.event) }, limits.deliverTimeoutMs);
    // Deleted only after the sink returned: a crash in between redelivers these events, which sinks deduplicate on event.id.
    const blank = await removeBuffered(driver, batch);
    progress.shipped += batch.length - blank.length;
    await redactBlank(driver, trail, blank);
    progress.shipped += blank.length;
    if (batch.length < limits.batchSize) break;
  }
}

/** Moves buffered events to each shipping trail's sink; a trail whose delivery fails on a connection, or a connection that cannot be searched, keeps its rows there and is named in `failed`. */
export async function shipAudit(options: ShipOptions = {}): Promise<ShipResult> {
  const trails = await shippingTrails(options.trail);
  if (trails.length === 0) return { shipped: 0, failed: [] };
  const failed: ShipFailure[] = [];
  const drivers = await bufferConnections(options.connection, (connection, error) => {
    failed.push(...trails.map((t) => ({ trail: t.name, connection })));
    log().error({ error, connection }, 'audit: connection ${connection} cannot be searched for buffered audit events');
  });
  const limits = shipLimits();
  const progress = { shipped: 0 };
  for (const trail of trails) {
    for (const driver of drivers) {
      try {
        await drain(driver, trail, limits, progress);
      } catch (err) {
        failed.push({ trail: trail.name, connection: driver.Options.Name });
        log().error({ error: err, trail: trail.name, connection: driver.Options.Name }, 'audit: shipping trail ${trail} from connection ${connection} failed, its events stay buffered');
      }
    }
  }
  return { shipped: progress.shipped, failed };
}
