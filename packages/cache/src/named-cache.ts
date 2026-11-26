import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { decodeValue, encodeValue } from './codec.js';
import { Cache } from './contracts.js';
import type { CacheEntry, CacheHit, CacheLookup, CacheOptions, CacheReadOptions, CacheSettings, CacheStore, CacheStoreRead, TagBump } from './contracts.js';
import { parseDuration } from './duration.js';
import { cacheKey } from './keys.js';
import { cacheLog } from './log.js';
import { scopeSegments } from './scope.js';
import type { CacheConfig } from './settings.js';

export interface OpenedStore {
  readonly store: CacheStore;
  readonly settings: CacheSettings;
}

/** What a NamedCache needs from the CacheService that made it. */
export interface CacheHost {
  readonly Container: IContainer;
  readonly config: CacheConfig;
  openStore(name: string): Promise<OpenedStore>;
  invalidate(tags: readonly string[]): Promise<void>;
}

interface Lifetime {
  readonly ttlMs: number;
  readonly swrMs: number;
}

/** The versions of a call's tags and when they were read. */
interface Reading {
  readonly versions: readonly string[];
  readonly at: number;
}

interface Produced<T> {
  readonly value: T;
  readonly bytes: Uint8Array;
}

const NOTHING_TO_FILL = async (): Promise<void> => undefined;

/** One named cache of a CacheService. A store failure is logged and read as a miss; misuse is thrown. */
export class NamedCache extends Cache {
  private opening: Promise<OpenedStore> | undefined;
  private openFailureLogged = false;

  constructor(
    public readonly name: string,
    private readonly host: CacheHost,
  ) {
    super();
  }

  public async get<T>(key: string, options: CacheReadOptions = {}): Promise<T | undefined> {
    const storeKey = this.key(key);
    if (storeKey === null) return undefined;
    const found = await this.read<T>(storeKey, options);
    return found !== undefined && !found.stale ? found.value : undefined;
  }

  public async set<T>(key: string, value: T, options: CacheOptions): Promise<void> {
    const life = this.lifetime(options);
    const bytes = encodeValue(value);
    const storeKey = this.key(key);
    if (storeKey === null) return;
    const tags = options.tags ?? [];
    const reading = await this.versionsOf(tags);
    if (reading !== undefined) await this.save(storeKey, bytes, tags, reading, life);
  }

  public async wrap<T>(key: string, options: CacheOptions, compute: () => Promise<T>): Promise<T> {
    const life = this.lifetime(options);
    const storeKey = this.key(key);
    if (storeKey === null) return compute();
    const found = await this.read<T>(storeKey, options);
    if (found !== undefined && !found.stale) return found.value;
    const reading = await this.versionsOf(options.tags ?? []);
    return (await this.produce(storeKey, options, life, compute, reading)).value;
  }

  public async lookup<T>(key: string, options: CacheOptions): Promise<CacheLookup<T>> {
    const life = this.lifetime(options);
    const storeKey = this.key(key);
    if (storeKey === null) return { hit: false, fill: NOTHING_TO_FILL };
    const found = await this.read<T>(storeKey, options);
    if (found !== undefined && !found.stale) return found;
    const tags = options.tags ?? [];
    const reading = await this.versionsOf(tags);
    // Claims nothing: the stale entry stays, and whoever calls fill() stores under the versions read here.
    const fill = async (value: T): Promise<void> => {
      const bytes = encodeValue(value);
      if (reading !== undefined) await this.save(storeKey, bytes, tags, reading, life);
    };
    return found === undefined ? { hit: false, fill } : { ...found, fill };
  }

  public async delete(key: string): Promise<void> {
    const storeKey = this.key(key);
    if (storeKey !== null) await this.remove(storeKey);
  }

  public async invalidate(tags: readonly string[]): Promise<void> {
    await this.host.invalidate(tags);
  }

  /** Bumps the tags in this cache's store, which it opens when this process has not used the cache yet. Never throws. */
  public async applyBumps(bumps: readonly TagBump[]): Promise<void> {
    if (bumps.length === 0) return;
    const opened = await this.opened().catch((error: unknown) => this.unopenable(error));
    if (opened === undefined) return;
    await this.guard('bump', undefined, () => opened.store.bump(bumps));
  }

  private async opened(): Promise<OpenedStore> {
    return this.opening ?? this.open();
  }

  private open(): Promise<OpenedStore> {
    const opening = this.host.openStore(this.name);
    this.opening = opening;
    // A configuration error reaches the caller; the next call opens again.
    void opening.catch(() => {
      if (this.opening === opening) this.opening = undefined;
    });
    return opening;
  }

  private key(key: string): string | null {
    const segments = scopeSegments(this.host.Container);
    return segments === null ? null : cacheKey(this.name, key, segments);
  }

  private lifetime(options: CacheOptions): Lifetime {
    const maxTtlMs = this.host.config.maxTtlMs;
    const ttl = parseDuration(options.ttl, 'ttl');
    if (!(ttl > 0)) throw new InvalidArgument(`ttl must be above 0, got ${String(options.ttl)}`, 'ttl');
    const ttlMs = Math.min(ttl, maxTtlMs);
    return { ttlMs, swrMs: Math.min(parseDuration(options.swr ?? 0, 'swr'), maxTtlMs - ttlMs) };
  }

  /** A valid entry younger than ttl + swr, decoded; undefined otherwise. An undecodable entry is deleted. */
  private async read<T>(storeKey: string, options: CacheReadOptions): Promise<CacheHit<T> | undefined> {
    const { store, settings } = await this.opened();
    const consistency = options.consistency ?? settings.consistency;
    const found = await this.guard<CacheStoreRead | undefined>('get', undefined, () => store.get(storeKey, { consistency }));
    if (found === undefined || !found.valid) return undefined;
    const age = Date.now() - found.entry.storedAt;
    if (age >= found.entry.ttlMs + found.entry.swrMs) return undefined;
    try {
      return { hit: true, value: decodeValue<T>(found.entry.value), stale: age >= found.entry.ttlMs };
    } catch (error) {
      this.failed('decode', error);
      await this.remove(storeKey);
      return undefined;
    }
  }

  /** `reading` was taken before compute(), so a bump during the computation leaves the stored entry invalid. */
  private async produce<T>(storeKey: string, options: CacheOptions, life: Lifetime, compute: () => Promise<T>, reading: Reading | undefined): Promise<Produced<T>> {
    const value = await compute();
    const bytes = encodeValue(value);
    if (reading !== undefined) await this.save(storeKey, bytes, options.tags ?? [], reading, life);
    return { value, bytes };
  }

  private async versionsOf(tags: readonly string[]): Promise<Reading | undefined> {
    const { store } = await this.opened();
    const at = Date.now();
    const versions = await this.guard<readonly string[] | undefined>('versions', undefined, () => store.versions(tags));
    return versions === undefined ? undefined : { versions, at };
  }

  private async save(storeKey: string, bytes: Uint8Array, tags: readonly string[], reading: Reading, life: Lifetime): Promise<void> {
    const { store } = await this.opened();
    const now = Date.now();
    // Counted from the reading, so maxTtl bounds every bump a store missed, however long the computation took.
    const left = this.host.config.maxTtlMs - (now - reading.at);
    if (left <= 0) return;
    const ttlMs = Math.min(life.ttlMs, left);
    const entry: CacheEntry = { value: bytes, tags, versions: reading.versions, storedAt: now, ttlMs, swrMs: Math.min(life.swrMs, left - ttlMs) };
    await this.guard('set', undefined, () => store.set(storeKey, entry));
  }

  private async remove(storeKey: string): Promise<void> {
    const { store } = await this.opened();
    await this.guard('delete', undefined, () => store.delete(storeKey));
  }

  private async guard<R>(op: string, fallback: R, call: () => Promise<R>): Promise<R> {
    try {
      return await call();
    } catch (error) {
      this.failed(op, error);
      return fallback;
    }
  }

  private failed(op: string, error: unknown): void {
    cacheLog.warn({ cache: this.name, op, error }, `cache ${this.name}: ${op} failed; read as a miss`);
  }

  /** A store this process cannot open (its package is not imported here) misses every invalidation; said once. */
  private unopenable(error: unknown): undefined {
    if (!this.openFailureLogged) {
      this.openFailureLogged = true;
      cacheLog.warn({ cache: this.name, error }, `cache ${this.name}: its store cannot be opened in this process, so invalidations here do not reach it`);
    }
    return undefined;
  }
}
