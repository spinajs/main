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
// The timeout of the audit.ship schedule (scheduler.ts), which this module cannot import: the scheduler is an optional peer.
const SCHEDULE_TIMEOUT_MS = 600000;

export interface ShipFailure {
  readonly trail: string;
  readonly connection: string;
}

export interface ShipResult {
  readonly shipped: number;
  readonly failed: readonly ShipFailure[];
  /** Present when audit.ship.runBudgetMs ended the run while events were left buffered. */
  readonly stoppedEarly?: true;
}

export interface ShipOptions {
  readonly trail?: string;
  readonly connection?: string;
}

interface ShipLimits {
  readonly batchSize: number;
  readonly maxBatches: number;
  readonly deliverTimeoutMs: number;
  readonly budgetMs: number;
  readonly stopAt: number;
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback);
const log = (): Log => DI.resolve(Log, ['audit-ship']);

function shipLimits(): ShipLimits {
  const raw: unknown = DI.get(Configuration)?.get<unknown>(['audit', 'ship']);
  const cfg = isRecord(raw) ? raw : {};
  const deliverTimeoutMs = positive(cfg.deliverTimeoutMs, DEFAULT_DELIVER_TIMEOUT_MS);
  const budgetMs = positive(cfg.runBudgetMs, DEFAULT_RUN_BUDGET_MS);
  if (budgetMs + deliverTimeoutMs > SCHEDULE_TIMEOUT_MS) throw new AuditConfigError(`audit: audit.ship.runBudgetMs (${budgetMs}) plus audit.ship.deliverTimeoutMs (${deliverTimeoutMs}) is over the ${SCHEDULE_TIMEOUT_MS} ms timeout of the audit.ship schedule; lower one of them`);
  return { batchSize: Math.min(positive(cfg.batchSize, DEFAULT_BATCH), MAX_BATCH), maxBatches: positive(cfg.maxBatches, DEFAULT_MAX_BATCHES), deliverTimeoutMs, budgetMs, stopAt: Date.now() + budgetMs };
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
    log().error({ trail: trail.name, connection: source, subjects: unique.map((s) => `${s.type}:${s.id}`).join(', ') }, 'audit: trail ${trail} shipped events from ${connection} that were erased before their delivery returned, and has no reader to redact them: the destination may hold an erased payload of ${subjects}');
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

/** How a trail ended on one connection: emptied or at maxBatches, or stopped by the run budget after or before its first batch. */
type Drained = 'done' | 'interrupted' | 'unstarted';

async function drain(driver: OrmDriver, trail: TrailConfig, limits: ShipLimits, progress: { shipped: number }): Promise<Drained> {
  const sink = await sinkOf(trail);
  const source = driver.Options.Name;
  // spinajs-orm-ignore ORM102: deliberate batching, one SELECT, one delivery and one DELETE per batch
  for (let i = 0; i < limits.maxBatches; i += 1) {
    const batch = await oldestBuffered(driver, trail.name, limits.batchSize);
    if (batch.length === 0) break;
    if (Date.now() >= limits.stopAt) return i === 0 ? 'unstarted' : 'interrupted';
    await deliverBy(sink, { trail: trail.name, source, events: batch.map((b) => b.event) }, limits.deliverTimeoutMs);
    // Deleted only after the sink returned: a crash in between redelivers these events, which sinks deduplicate on event.id.
    const blank = await removeBuffered(driver, batch);
    progress.shipped += batch.length - blank.length;
    await redactBlank(driver, trail, blank);
    progress.shipped += blank.length;
    if (batch.length < limits.batchSize) break;
  }
  return 'done';
}

interface Target {
  readonly trail: TrailConfig;
  readonly driver: OrmDriver;
  readonly key: string;
}

// Where the next full run starts, so a slow trail or connection cannot take every run's budget: at the pair the budget
// stopped before it shipped anything, or after the pair it interrupted.
let resume: { readonly key: string; readonly after: boolean } | undefined;

function rotated(targets: readonly Target[]): Target[] {
  const at = resume === undefined ? -1 : targets.findIndex((t) => t.key === resume?.key);
  const start = at < 0 ? 0 : at + (resume?.after === true ? 1 : 0);
  return [...targets.slice(start), ...targets.slice(0, start)];
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
  const left: { readonly key: string; readonly after: boolean }[] = [];
  const targets = trails.flatMap((trail) => drivers.map((driver) => ({ trail, driver, key: `${trail.name}@${driver.Options.Name}` })));
  for (const { trail, driver, key } of rotated(targets)) {
    try {
      const drained = await drain(driver, trail, limits, progress);
      if (drained !== 'done') left.push({ key, after: drained === 'interrupted' });
    } catch (err) {
      failed.push({ trail: trail.name, connection: driver.Options.Name });
      log().error({ error: err, trail: trail.name, connection: driver.Options.Name }, 'audit: shipping trail ${trail} from connection ${connection} failed, its events stay buffered');
    }
  }
  // A narrowed run sees only part of the rotation.
  if (options.trail === undefined && options.connection === undefined) resume = left[0];
  if (left.length === 0) return { shipped: progress.shipped, failed };
  log().warn({ budget: limits.budgetMs, left: left.map((l) => l.key).join(', ') }, 'audit: the shipping run stopped at audit.ship.runBudgetMs (${budget} ms); left buffered for the next run: ${left}');
  return { shipped: progress.shipped, failed, stoppedEarly: true };
}
