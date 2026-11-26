import { Injectable, NewInstance } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Breaker } from './breaker.js';
import { CacheStore } from './contracts.js';
import type { CacheEntry, CacheSettings, CacheStoreRead, CacheStoreReadOptions, TagBump } from './contracts.js';
import { CacheConfigError } from './errors.js';
import { cacheLog } from './log.js';
import { MemoryCacheStore } from './memory-store.js';
import { resolveStore } from './settings.js';

// No store answers a version that is empty or contains '|', so the first '|' ends the upper part.
const SEP = '|';
const UNREAD = '';
const MISSED_TAGS_CAP = 10_000;

function split(version: string): [string, string] {
  const at = version.indexOf(SEP);
  return at < 0 ? [version, UNREAD] : [version.slice(0, at), version.slice(at + 1)];
}

const alive = (entry: CacheEntry, now: number): boolean => now - entry.storedAt < entry.ttlMs + entry.swrMs;

/** A MemoryCacheStore in front of a shared store. Versions are '<upper>|<lower>'; an unread lower part keeps the entry in the upper tier alone. */
@NewInstance()
@Injectable(CacheStore)
export class TieredCacheStore extends CacheStore {
  private upper: MemoryCacheStore;
  private lower: CacheStore;
  private breaker: Breaker;
  private cacheName = '';
  private maxTtlMs = 3_600_000;
  // Tags whose bump the lower tier refused here, by time: an entry it holds under one of them may predate that bump.
  private readonly missed = new Map<string, number>();
  private distrustAllSince = Number.NEGATIVE_INFINITY;

  public async configure(settings: CacheSettings, container: IContainer): Promise<void> {
    const path = `cache.caches.${settings.name}`;
    const upperName = typeof settings.raw.upper === 'string' ? settings.raw.upper : 'MemoryCacheStore';
    const lowerName = settings.raw.lower;
    if (typeof lowerName !== 'string') throw new CacheConfigError(`${path}.lower: a TieredCacheStore needs the name of its shared store`);
    const upper = await resolveStore(container, upperName, `${path}.upper`);
    if (!(upper instanceof MemoryCacheStore)) throw new CacheConfigError(`${path}.upper '${upperName}': the upper tier must be a MemoryCacheStore`);
    const lower = await resolveStore(container, lowerName, `${path}.lower`);
    if (lower instanceof TieredCacheStore) throw new CacheConfigError(`${path}.lower '${lowerName}': a TieredCacheStore cannot be a tier`);
    await upper.configure(settings);
    await lower.configure(settings, container);
    this.useTiers(upper, lower, new Breaker(settings.breakerFailures, settings.breakerResetMs), settings.name, settings.maxTtlMs);
  }

  public useTiers(upper: MemoryCacheStore, lower: CacheStore, breaker = new Breaker(5, 10_000), cacheName = '', maxTtlMs = 3_600_000): this {
    this.upper = upper;
    this.lower = lower;
    this.breaker = breaker;
    this.cacheName = cacheName;
    this.maxTtlMs = maxTtlMs;
    return this;
  }

  public async get(key: string, options: CacheStoreReadOptions = {}): Promise<CacheStoreRead | undefined> {
    if (options.consistency === 'strict') return this.trusted(await this.fromLower('get', () => this.lower.get(key, options)));
    const near = this.upper.read(key);
    // An upper entry past its life is not served: the lower tier may hold a newer one.
    if (near?.valid === true && alive(near.entry, Date.now())) return near;
    const epoch = this.upper.epoch;
    const far = this.trusted(await this.fromLower('get', () => this.lower.get(key, options)));
    // A bump that arrived during the read may postdate the lower tier's answer; stamping the copy now would hide it.
    // The copy keeps storedAt and the lifetime of the entry, so it ends when the entry does.
    if (far?.valid === true && this.upper.epoch === epoch) this.upper.write(key, { ...far.entry, versions: this.upper.versionsNow(far.entry.tags) });
    return far;
  }

  public async set(key: string, entry: CacheEntry): Promise<void> {
    const parts = entry.versions.map(split);
    this.upper.write(key, { ...entry, versions: parts.map(([near]) => near) });
    if (parts.some(([, far]) => far === UNREAD)) return;
    await this.fromLower('set', () => this.lower.set(key, { ...entry, versions: parts.map(([, far]) => far) }));
  }

  public async delete(key: string): Promise<void> {
    await this.upper.delete(key);
    await this.fromLower('delete', () => this.lower.delete(key));
  }

  public async versions(tags: readonly string[]): Promise<readonly string[]> {
    const near = this.upper.versionsNow(tags);
    const far = tags.length === 0 ? [] : await this.fromLower('versions', () => this.lower.versions(tags));
    return near.map((version, i) => `${version}${SEP}${far?.at(i) ?? UNREAD}`);
  }

  /** The lower tier is bumped whatever its breaker says: a skipped bump would leave entries valid that are not. */
  public async bump(bumps: readonly TagBump[]): Promise<void> {
    this.upper.bumpNow(bumps);
    try {
      await this.lower.bump(bumps);
      this.breaker.succeeded();
      for (const { tag } of bumps) this.missed.delete(tag);
    } catch (error) {
      this.lowerFailed('bump', error);
      this.distrust(bumps, Date.now());
    }
  }

  private async fromLower<R>(op: string, call: () => Promise<R>): Promise<R | undefined> {
    if (!this.breaker.allows()) return undefined;
    try {
      const result = await call();
      this.breaker.succeeded();
      return result;
    } catch (error) {
      this.lowerFailed(op, error);
      return undefined;
    }
  }

  // The upper tier took a bump the lower one refused: a lower entry under that tag is invalid here until a later bump
  // of the tag reaches the lower tier, or until maxTtl has passed and every entry read before the bump has ended.
  private trusted(read: CacheStoreRead | undefined): CacheStoreRead | undefined {
    if (read?.valid !== true) return read;
    const now = Date.now();
    const recent = (at: number | undefined): boolean => at !== undefined && now - at < this.maxTtlMs;
    const doubtful = recent(this.distrustAllSince) || read.entry.tags.some((tag) => recent(this.missed.get(tag)));
    return doubtful ? { ...read, valid: false } : read;
  }

  private distrust(bumps: readonly TagBump[], now: number): void {
    for (const { tag } of bumps) {
      this.missed.delete(tag);
      this.missed.set(tag, now);
    }
    for (const [tag, at] of this.missed) {
      if (now - at < this.maxTtlMs) break;
      this.missed.delete(tag);
    }
    if (this.missed.size > MISSED_TAGS_CAP) {
      this.missed.clear();
      this.distrustAllSince = now;
    }
  }

  private lowerFailed(op: string, error: unknown): void {
    const opened = this.breaker.failed();
    const outcome = opened ? 'it keeps failing and is not called for a while' : 'read as a miss';
    cacheLog.warn({ cache: this.cacheName, op, error }, `cache ${this.cacheName}: lower tier ${op} failed; ${outcome}`);
  }
}
