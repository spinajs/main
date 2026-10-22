import { randomUUID } from 'node:crypto';
import { Config } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import { EmailVerificationStore } from '@spinajs/email-verification';
import type { CachedVerdict, ListEntry, ListKind, OrmStoreOptions, VerdictResult } from '@spinajs/email-verification';
import { InvalidOperation } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Orm } from '@spinajs/orm';
import type { IUpdateResult, IWhereBuilder, OrmDriver } from '@spinajs/orm';
import { chunk } from '@spinajs/util';

import { ENTRIES_TABLE, META_TABLE, SOURCES_TABLE, VERDICTS_TABLE } from './tables.js';

interface VerdictRow {
  key: string;
  result: string;
  reason: string | null;
  source: string | null;
  checked_at: number | string;
  expires_at: number | string;
}

interface SourceRow {
  key: string;
  gen: string;
}

const MAX_ATTEMPTS = 5;
// 200 rows x 4 columns stays under the bound-parameter limits of sqlite (999) and MSSQL (2100).
const INSERT_CHUNK = 200;
const CLEANUP_BATCH = 500;
// A writer fills its generation before it points a source at it; younger unreferenced rows may be in flight.
// A writer that stalls longer than this can lose its generation to the sweep; all nodes' clocks must agree within it.
const DEAD_GENERATION_GRACE_MS = 60 * 60 * 1000;
const LIST_VERSION = 'listVersion';

const rowsAffected = (result: unknown) => (result as IUpdateResult | undefined)?.RowsAffected ?? 0;
const sourceKey = (kind: ListKind, source: string) => `${kind}|${source}`;
const splitSourceKey = (key: string): [ListKind, string] => {
  const at = key.indexOf('|');
  return [key.slice(0, at) as ListKind, key.slice(at + 1)];
};

/**
 * Each list source points at a generation of entry rows. A write fills a new generation,
 * moves the pointer with a compare-and-set, then drops the old rows. A read checks that
 * no pointer moved while it read, so it never returns a half-replaced source.
 */
@Injectable(EmailVerificationStore)
export class OrmEmailVerificationStore extends EmailVerificationStore {
  @Config('emailVerification.orm')
  protected Options: OrmStoreOptions;

  @Logger('email-verification')
  protected Log: Log;

  protected CleanupTimer: ReturnType<typeof setInterval> | undefined;

  protected CleanupRunning = false;

  public async resolve(): Promise<void> {
    this.CleanupTimer = setInterval(() => void this.runCleanup(), this.Options.cleanupIntervalMs);
    this.CleanupTimer.unref?.();
    await super.resolve();
  }

  public async dispose(): Promise<void> {
    clearInterval(this.CleanupTimer);
    this.CleanupTimer = undefined;
  }

  /** A tick that finds the previous cleanup still running is skipped. */
  protected async runCleanup(): Promise<void> {
    if (this.CleanupRunning) return;
    this.CleanupRunning = true;
    try {
      await this.cleanupExpired();
    } catch (err) {
      this.Log.error(err as Error, 'Email verification cleanup failed');
    } finally {
      this.CleanupRunning = false;
    }
  }

  /** Deletes expired verdicts and the entries of generations no source points at (left by failed writes). */
  public async cleanupExpired(): Promise<number> {
    const d = await this.driver();
    const now = Date.now();
    const verdicts = await this.deleteInBatches(d, VERDICTS_TABLE, (q) => q.where('expires_at', '<=', now));
    return verdicts + (await this.deleteDeadGenerations(d, now - DEAD_GENERATION_GRACE_MS));
  }

  protected async deleteDeadGenerations(d: OrmDriver, createdBefore: number): Promise<number> {
    const gens = (await d.select().from(ENTRIES_TABLE).columns(['gen']).max('created_at', 'newest').groupBy('gen')) as { gen: string; newest: number | string }[];
    // Read after the generations, so a pointer moved in between still protects its generation.
    const live = new Set((await this.sourceRows(d)).map((r) => r.gen));
    let removed = 0;
    for (const { gen, newest } of gens) {
      if (!live.has(gen) && Number(newest) < createdBefore) removed += await this.deleteInBatches(d, ENTRIES_TABLE, (q) => q.where({ gen }));
    }
    return removed;
  }

  protected async deleteInBatches(d: OrmDriver, table: string, filter: (q: IWhereBuilder<unknown>) => unknown): Promise<number> {
    let removed = 0;
    for (;;) {
      const select = d.select().from(table).columns(['key']).orderBy('key').take(CLEANUP_BATCH);
      filter(select);
      const keys = ((await select) as { key: string }[]).map((r) => r.key);
      if (keys.length === 0) break;
      // The filter is applied again so a row refreshed since the select survives.
      const del = d.del().from(table).whereIn('key', keys);
      filter(del);
      const deleted = rowsAffected(await del);
      removed += deleted;
      if (keys.length < CLEANUP_BATCH || deleted === 0) break;
    }
    return removed;
  }

  public async getVerdict(verifier: string, domain: string): Promise<CachedVerdict | null> {
    const rows = (await (await this.driver()).select().from(VERDICTS_TABLE).where({ key: `${verifier}:${domain}` })) as VerdictRow[];
    const row = rows[0];
    if (!row || Number(row.expires_at) <= Date.now()) return null;
    return {
      result: row.result as VerdictResult,
      checkedAt: Number(row.checked_at),
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.source === null ? {} : { source: row.source }),
    };
  }

  public async setVerdict(verifier: string, domain: string, verdict: CachedVerdict, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) return;
    const values = {
      result: verdict.result,
      reason: verdict.reason ?? null,
      source: verdict.source ?? null,
      checked_at: verdict.checkedAt,
      expires_at: Date.now() + ttlSeconds * 1000,
    };
    await this.upsert(VERDICTS_TABLE, `${verifier}:${domain}`, values);
  }

  public async getMeta(key: string): Promise<string | null> {
    const rows = (await (await this.driver()).select().from(META_TABLE).where({ key })) as { value: string }[];
    return rows[0]?.value ?? null;
  }

  public async setMeta(key: string, value: string): Promise<void> {
    await this.upsert(META_TABLE, key, { value });
  }

  public async listVersion(): Promise<string> {
    return (await this.getMeta(LIST_VERSION)) ?? '0';
  }

  public async loadLists(): Promise<ListEntry[]> {
    const d = await this.driver();
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const before = await this.sourceRows(d);
      const entries: ListEntry[] = [];
      for (const row of before) {
        const [kind, source] = splitSourceKey(row.key);
        for (const domain of await this.domainsOf(d, row.gen)) entries.push({ domain, kind, source });
      }
      const after = await this.sourceRows(d);
      if (samePointers(before, after)) return entries;
    }
    throw new InvalidOperation(`email domain lists kept changing during ${MAX_ATTEMPTS} reads`);
  }

  public async upsertEntries(entries: readonly ListEntry[]): Promise<void> {
    for (const [key, domains] of groupBySource(entries)) {
      const [kind, source] = splitSourceKey(key);
      await this.mutateSource(kind, source, (current) => new Set([...current, ...domains]));
    }
  }

  public async removeEntries(kind: ListKind, domains: readonly string[], source: string): Promise<void> {
    await this.mutateSource(kind, source, (current) => {
      domains.forEach((d) => current.delete(d));
      return current;
    });
  }

  public async replaceSource(source: string, kind: ListKind, domains: readonly string[]): Promise<void> {
    await this.mutateSource(kind, source, () => new Set(domains), false);
  }

  protected async mutateSource(kind: ListKind, source: string, change: (current: Set<string>) => Set<string>, readCurrent = true): Promise<void> {
    const d = await this.driver();
    const key = sourceKey(kind, source);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const old = await this.sourceRow(d, key);
      const current = new Set(old && readCurrent ? await this.domainsOf(d, old.gen) : []);
      if (await this.swap(d, key, old?.gen, [...change(current)])) {
        try {
          await this.setMeta(LIST_VERSION, randomUUID());
        } finally {
          if (old) await this.dropGeneration(d, old.gen, 'Cannot drop an old email domain list generation; the cleanup will reclaim it');
        }
        return;
      }
    }
    throw new InvalidOperation(`email domain list ${key} kept changing during ${MAX_ATTEMPTS} writes`);
  }

  /** Points `key` at a new generation holding `domains`; false when another writer moved it first. */
  protected async swap(d: OrmDriver, key: string, oldGen: string | undefined, domains: string[]): Promise<boolean> {
    if (domains.length === 0) {
      if (oldGen === undefined) return true;
      try {
        return rowsAffected(await d.del().from(SOURCES_TABLE).where({ key, gen: oldGen })) === 1;
      } catch (err) {
        // The delete may have landed before the client saw the error.
        if ((await this.sourceRow(d, key)) === undefined) return true;
        throw err;
      }
    }
    const gen = randomUUID();
    const createdAt = Date.now();
    try {
      for (const part of chunk(domains, INSERT_CHUNK)) {
        await d.insert().into(ENTRIES_TABLE).values(part.map((domain) => ({ key: `${gen}|${domain}`, gen, domain, created_at: createdAt })));
      }
    } catch (err) {
      await this.dropGeneration(d, gen, 'Cannot drop an unfinished email domain list generation; the cleanup will reclaim it');
      throw err;
    }
    let moved: boolean;
    try {
      moved = oldGen === undefined ? await this.insertSource(d, key, gen) : rowsAffected(await d.update().in(SOURCES_TABLE).update({ gen }).where({ key, gen: oldGen })) === 1;
    } catch (err) {
      // The pointer may still move to `gen` after the error, so its rows are left to the sweep, which waits out the grace period.
      if ((await this.sourceRow(d, key).catch(() => undefined))?.gen === gen) return true;
      throw err;
    }
    if (!moved) await this.dropGeneration(d, gen, 'Cannot drop an unused email domain list generation; the cleanup will reclaim it');
    return moved;
  }

  /** Best effort: a generation no source points at is reclaimed by the cleanup anyway. */
  protected async dropGeneration(d: OrmDriver, gen: string, failure: string): Promise<void> {
    try {
      await d.del().from(ENTRIES_TABLE).where({ gen });
    } catch (err) {
      this.Log.warn(err as Error, failure);
    }
  }

  protected async insertSource(d: OrmDriver, key: string, gen: string): Promise<boolean> {
    try {
      await d.insert().into(SOURCES_TABLE).values({ key, gen });
      return true;
    } catch (err) {
      const row = await this.sourceRow(d, key);
      if (row === undefined) throw err;
      // Our insert may have committed even though the client saw an error.
      return row.gen === gen;
    }
  }

  protected async upsert(table: string, key: string, values: Record<string, unknown>): Promise<void> {
    await (await this.driver()).insert().into(table).values({ key, ...values }).onDuplicate('key').update(Object.keys(values));
  }

  protected async sourceRow(d: OrmDriver, key: string): Promise<SourceRow | undefined> {
    return ((await d.select().from(SOURCES_TABLE).where({ key })) as SourceRow[])[0];
  }

  protected async sourceRows(d: OrmDriver): Promise<SourceRow[]> {
    return (await d.select().from(SOURCES_TABLE)) as SourceRow[];
  }

  protected async domainsOf(d: OrmDriver, gen: string): Promise<string[]> {
    return ((await d.select().from(ENTRIES_TABLE).where({ gen })) as { domain: string }[]).map((r) => r.domain);
  }

  protected async driver(): Promise<OrmDriver> {
    const orm = await DI.resolve(Orm);
    const driver = orm.Connections.get(this.Options.connection);
    if (!driver) {
      throw new InvalidOperation(`emailVerification.orm.connection names ${this.Options.connection}, which the ORM does not have (connections: ${[...orm.Connections.keys()].join(', ') || 'none'})`);
    }
    return driver;
  }
}

function samePointers(a: SourceRow[], b: SourceRow[]): boolean {
  if (a.length !== b.length) return false;
  const gens = new Map(a.map((r) => [r.key, r.gen]));
  return b.every((r) => gens.get(r.key) === r.gen);
}

function groupBySource(entries: readonly ListEntry[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const key = sourceKey(e.kind, e.source);
    groups.set(key, [...(groups.get(key) ?? []), e.domain]);
  }
  return groups;
}
