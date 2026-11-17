import { AuditConfigError, AuditEventSink } from '@spinajs/audit';
import type { TrailConfig } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Log } from '@spinajs/log-common';
import type { OrmDriver } from '@spinajs/orm';

import { auditConnection } from '../rows.js';
import { oldestBuffered, removeBuffered } from './outbox.js';
import { distinctConnections, namedService } from './services.js';
import { AUDIT_OUTBOX_TABLE } from './table.js';
import { shippingTrails } from './trails.js';

const DEFAULT_BATCH = 200;
// Keeps the id list of a sink's dedup select under the bind limit of every driver (SQLite 999, MSSQL 2100).
const MAX_BATCH = 500;
const DEFAULT_MAX_BATCHES = 50;

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
}

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> => v !== null && typeof v === 'object' && !Array.isArray(v);
const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback);

function shipLimits(): ShipLimits {
  const raw: unknown = DI.get(Configuration)?.get<unknown>(['audit', 'ship']);
  const cfg = isRecord(raw) ? raw : {};
  return { batchSize: Math.min(positive(cfg.batchSize, DEFAULT_BATCH), MAX_BATCH), maxBatches: positive(cfg.maxBatches, DEFAULT_MAX_BATCHES) };
}

/** The connections that hold audit_outbox; `only` narrows to one connection name. */
export async function bufferConnections(only?: string): Promise<OrmDriver[]> {
  const candidates = only === undefined ? distinctConnections() : [auditConnection(only)];
  const found: OrmDriver[] = [];
  for (const driver of candidates) {
    if (await driver.schema().tableExists(AUDIT_OUTBOX_TABLE)) found.push(driver);
  }
  return found;
}

function sinkOf(trail: TrailConfig): Promise<AuditEventSink> {
  if (trail.sink === undefined) return Promise.reject(new AuditConfigError(`audit: trail ${JSON.stringify(trail.name)} uses OutboxAuditStore but names no sink (audit.trails.${trail.name}.sink)`));
  return namedService(AuditEventSink, trail.sink, `audit.trails.${trail.name}.sink`);
}

async function drain(driver: OrmDriver, trail: TrailConfig, limits: ShipLimits): Promise<number> {
  const sink = await sinkOf(trail);
  let shipped = 0;
  // spinajs-orm-ignore ORM102: deliberate batching, one SELECT, one delivery and one DELETE per batch
  for (let i = 0; i < limits.maxBatches; i += 1) {
    const batch = await oldestBuffered(driver, trail.name, limits.batchSize);
    if (batch.length === 0) break;
    await sink.deliver({ trail: trail.name, source: driver.Options.Name, events: batch.map((b) => b.event) });
    // Deleted only after the sink returned: a crash in between redelivers these events, which sinks deduplicate on event.id.
    await removeBuffered(
      driver,
      batch.map((b) => b.seq),
    );
    shipped += batch.length;
    if (batch.length < limits.batchSize) break;
  }
  return shipped;
}

/** Moves buffered events to each shipping trail's sink; a trail whose delivery fails on a connection keeps its rows there and is named in `failed`. */
export async function shipAudit(options: ShipOptions = {}): Promise<ShipResult> {
  const trails = await shippingTrails(options.trail);
  if (trails.length === 0) return { shipped: 0, failed: [] };
  const drivers = await bufferConnections(options.connection);
  const limits = shipLimits();
  let shipped = 0;
  const failed: ShipFailure[] = [];
  for (const trail of trails) {
    for (const driver of drivers) {
      try {
        shipped += await drain(driver, trail, limits);
      } catch (err) {
        failed.push({ trail: trail.name, connection: driver.Options.Name });
        DI.resolve(Log, ['audit-ship']).error({ error: err, trail: trail.name, connection: driver.Options.Name }, 'audit: shipping trail ${trail} from connection ${connection} failed, its events stay buffered');
      }
    }
  }
  return { shipped, failed };
}
