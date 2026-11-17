import { AuditConfigError, eventsHash, sealHash, trailConfig, trailNames } from '@spinajs/audit';
import type { TrailConfig } from '@spinajs/audit';
import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';
import type { OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import { assertOwnTable, isTableTrail } from '../own-tables.js';
import { rowsOf } from '../rows.js';
import { archiveDriver } from '../ship/archive.js';
import { distinctConnections } from '../ship/services.js';
import { TableAuditStore } from '../table-store.js';
import { lastSeal, rowDigest } from './seals.js';
import { AUDIT_SEAL_TABLE } from './table.js';

const DEFAULT_SEAL_BATCH = 1000;
const MAX_SEAL_BATCH = 5000;
const DEFAULT_SETTLE_SECONDS = 30;
const DEFAULT_MAX_SEALS = 100;

const quoted = (v: string): string => JSON.stringify(v);
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

class SealConflict extends InvalidOperation {}

interface SealTableOptions {
  /** Seal no event after this seq; default: every event there is. */
  readonly upTo?: number;
  readonly batchSize: number;
  /** Seals one run may add to the table. */
  readonly maxSeals: number;
  readonly now: Date;
}

interface SealedHead {
  readonly sealed: number;
  readonly toSeq: number;
  readonly hash: string | null;
}

// One seal: the events after the last seal, read and sealed in one transaction.
async function sealNext(driver: OrmDriver, table: string, options: SealTableOptions, attempt: { from?: number }): Promise<SealedHead> {
  const last = await lastSeal(driver, table);
  const after = last?.toSeq ?? 0;
  attempt.from = after + 1;
  const previous = last?.hash ?? null;
  const select: SelectQueryBuilder<unknown> = driver.select().from(table).where('seq', '>', after);
  if (options.upTo !== undefined) select.where('seq', '<=', options.upTo);
  const rows = rowsOf(await select.orderBy('seq').take(options.batchSize));
  if (rows.length === 0) return { sealed: 0, toSeq: after, hash: previous };
  // Whole seconds: what every dialect's dateTime stores and reads back unchanged.
  const sealedAt = new Date(Math.floor(options.now.getTime() / 1000) * 1000);
  const events = eventsHash(rows.map((row) => rowDigest(row)));
  const hash = sealHash(previous, sealedAt, events);
  const toSeq = Number(rows[rows.length - 1].seq);
  // A range starts where the previous one ended, not at the first row seen: a row that commits later inside it changes its
  // count, and a second seal chained from the same one starts at the same seq, which the unique index refuses.
  await driver
    .insert()
    .into(AUDIT_SEAL_TABLE)
    .values({ trail_table: table, from_seq: after + 1, to_seq: toSeq, event_count: rows.length, events_hash: events, hash, previous_hash: previous, sealed_at: sealedAt });
  return { sealed: rows.length, toSeq, hash };
}

// The unique index refused our seal because another sealer chained one from the same seal first.
async function conflictOr(driver: OrmDriver, table: string, from: number | undefined, err: unknown): Promise<never> {
  const latest = from === undefined ? undefined : await lastSeal(driver, table).catch(() => undefined);
  if (latest !== undefined && latest.fromSeq === from) throw new SealConflict(`audit: another sealer sealed ${quoted(table)} on connection ${quoted(driver.Options.Name)} from seq ${from} at the same time; run one sealer (AuditSealTask runs on the leader)`, err);
  throw err;
}

/**
 * Seals the events of one table after its last seal, one seal per `batchSize` events, each chained to the one before.
 * Each seal is read and written in a transaction of its own, never in a caller's: there it would see rows that can still
 * roll back. sqlite and PGlite hold it until a caller's open transaction ends.
 */
async function sealTable(driver: OrmDriver, table: string, options: SealTableOptions): Promise<SealedHead> {
  if (driver.CurrentTransaction !== undefined) throw new InvalidOperation(`audit: sealing ${quoted(table)} on connection ${quoted(driver.Options.Name)} needs a transaction of its own; run it outside an open transaction`);
  let sealed = 0;
  // spinajs-orm-ignore ORM102: deliberate batching, one transaction per seal
  for (let seals = 1; ; seals += 1) {
    const attempt: { from?: number } = {};
    const step = await driver.transaction(() => sealNext(driver, table, options, attempt)).catch((err: unknown) => conflictOr(driver, table, attempt.from, err));
    sealed += step.sealed;
    if (step.sealed < options.batchSize || seals >= options.maxSeals) return { ...step, sealed };
  }
}

interface SealTarget {
  readonly driver: OrmDriver;
  readonly table: string;
}

/**
 * Where a trail's events are sealed: its archive table when it has one here, else, for a table store, its table on every
 * connection that holds it. A buffer is never sealed, and a trail of any other store keeps no table to seal.
 */
async function sealTargets(trail: TrailConfig): Promise<SealTarget[]> {
  if (trail.archiveConnection !== undefined) return [{ driver: archiveDriver(trail), table: trail.table }];
  // A shipping trail without an archive here is sealed by the service that holds its archive.
  if (trail.sink !== undefined) return [];
  if (!isTableTrail(trail, TableAuditStore)) throw new AuditConfigError(`audit: trail ${quoted(trail.name)} is sealed, but its store ${trail.store} keeps no table to seal`);
  assertOwnTable(trail, TableAuditStore);
  const targets: SealTarget[] = [];
  // spinajs-orm-ignore ORM102: one metadata query per connection
  for (const driver of distinctConnections()) {
    if (await driver.schema().tableExists(trail.table)) targets.push({ driver, table: trail.table });
  }
  return targets;
}

export interface SealFailure {
  readonly trail: string;
  readonly connection: string;
  readonly reason: string;
}

export interface SealResult {
  readonly sealed: number;
  readonly failed: readonly SealFailure[];
}

export interface SealOptions {
  readonly trail?: string;
  /** Default `audit.seal.settleSeconds`. 0 seals up to the current head: for tests, since a row that commits later lands in a sealed range. */
  readonly settleMs?: number;
  readonly now?: Date;
}

interface NotedHead {
  readonly seq: number;
  readonly at: number;
}

interface SealRun {
  readonly settleMs: number;
  readonly batchSize: number;
  readonly maxSeals: number;
  readonly now: Date;
}

const positive = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : fallback);

function sealConfig(): { settleMs: number; batchSize: number; maxSeals: number } {
  const cfg = DI.get(Configuration)?.get<{ settleSeconds?: unknown; batchSize?: unknown; maxSeals?: unknown } | undefined>(['audit', 'seal']);
  const settle = typeof cfg?.settleSeconds === 'number' && cfg.settleSeconds >= 0 ? cfg.settleSeconds : DEFAULT_SETTLE_SECONDS;
  return { settleMs: settle * 1000, batchSize: Math.min(positive(cfg?.batchSize, DEFAULT_SEAL_BATCH), MAX_SEAL_BATCH), maxSeals: positive(cfg?.maxSeals, DEFAULT_MAX_SEALS) };
}

function sealedTrails(only?: string): TrailConfig[] {
  return trailNames()
    .filter((name) => only === undefined || name === only)
    .map((name) => trailConfig(name))
    .filter((trail) => trail.integrity === 'sealed');
}

async function headOf(target: SealTarget): Promise<number> {
  const rows = rowsOf(await target.driver.select().from(target.table).columns(['seq']).orderByDescending('seq').take(1));
  return rows.length === 0 ? 0 : Number(rows[0].seq);
}

// After a seq reset (a re-created table, a MySQL 5.7 restart once retention emptied it) new rows get seqs at or below the
// chain's end, where no seal reaches them.
async function assertNoReset(target: SealTarget, head: number): Promise<void> {
  if (head === 0) return;
  const last = await lastSeal(target.driver, target.table);
  if (last === undefined || head > last.toSeq || (head === last.toSeq && !last.pruned)) return;
  throw new InvalidOperation(`audit: the highest seq of ${quoted(target.table)} on connection ${quoted(target.driver.Options.Name)} is ${head}, at or below the end of its seal chain (${last.toSeq}): the seq was reset, and rows up to seq ${last.toSeq} are never sealed`);
}

const log = (): Log => DI.resolve(Log, ['audit-seal']);

/** Seals the sealed trails. It remembers, per table, the head it saw on an earlier run; one instance serves one process. */
export class AuditSealer {
  private readonly heads = new Map<string, NotedHead>();

  async run(options: SealOptions = {}): Promise<SealResult> {
    const cfg = sealConfig();
    const run: SealRun = { settleMs: options.settleMs ?? cfg.settleMs, batchSize: cfg.batchSize, maxSeals: cfg.maxSeals, now: options.now ?? new Date() };
    const seen = new Set<string>();
    const failed: SealFailure[] = [];
    let sealed = 0;
    // spinajs-orm-ignore ORM102: one seal run per sealed table, each a batched loop of its own
    for (const trail of sealedTrails(options.trail)) {
      for (const target of await this.targetsOf(trail, failed)) {
        const key = `${target.driver.Options.Name}\u0000${target.table}`;
        // Two trails that name one table share its seals.
        if (seen.has(key)) continue;
        seen.add(key);
        sealed += await this.sealOne(trail, target, key, run, failed);
      }
    }
    return { sealed, failed };
  }

  private async targetsOf(trail: TrailConfig, failed: SealFailure[]): Promise<SealTarget[]> {
    try {
      return await sealTargets(trail);
    } catch (err) {
      const reason = messageOf(err);
      failed.push({ trail: trail.name, connection: trail.archiveConnection ?? trail.connection, reason });
      log().warn({ trail: trail.name, reason }, 'audit: trail ${trail} is not sealed: ${reason}');
      return [];
    }
  }

  private async sealOne(trail: TrailConfig, target: SealTarget, key: string, run: SealRun, failed: SealFailure[]): Promise<number> {
    const connection = target.driver.Options.Name;
    try {
      const head = await headOf(target);
      await assertNoReset(target, head);
      const upTo = run.settleMs <= 0 ? undefined : this.settled(key, head, run);
      if (upTo === null) return 0;
      const out = await sealTable(target.driver, target.table, { upTo, batchSize: run.batchSize, maxSeals: run.maxSeals, now: run.now });
      // The head in the application log is a copy of the chain's end outside the database.
      if (out.sealed > 0) log().info({ trail: trail.name, connection, table: target.table, toSeq: out.toSeq, hash: out.hash }, 'audit: sealed ${table} on ${connection} up to seq ${toSeq}, head ${hash}');
      return out.sealed;
    } catch (err) {
      const reason = messageOf(err);
      failed.push({ trail: trail.name, connection, reason });
      if (err instanceof InvalidOperation) log().warn({ trail: trail.name, connection, table: target.table, reason }, 'audit: sealing ${table} on ${connection} stopped: ${reason}');
      else log().error({ error: err, trail: trail.name, connection, table: target.table }, 'audit: sealing ${table} on ${connection} failed; is audit_seal migrated there (AuditSealTableMigration)?');
      return 0;
    }
  }

  /**
   * The seq this run may seal up to, null for nothing yet. A row can commit a lower seq after a higher one was read, so
   * the run seals what was the head one settle time ago and notes the current head for a later run.
   */
  private settled(key: string, head: number, run: SealRun): number | null {
    const noted = this.heads.get(key);
    if (noted !== undefined && run.now.getTime() - noted.at < run.settleMs) return null;
    this.heads.set(key, { seq: head, at: run.now.getTime() });
    return noted?.seq ?? null;
  }
}

const sealer = new AuditSealer();

/** Seals every sealed trail, or one; what AuditSealTask runs. */
export function sealAudit(options?: SealOptions): Promise<SealResult> {
  return sealer.run(options);
}
