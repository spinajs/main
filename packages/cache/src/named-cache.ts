import type { IContainer } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { decodeValue, encodeValue } from './codec.js';
import { Cache } from './contracts.js';
import type { CacheEntry, CacheHit, CacheLookup, CacheOptions, CacheReadOptions, CacheSettings, CacheStore, CacheStoreRead, TagBump } from './contracts.js';
import { parseDuration } from './duration.js';
import { CacheConfigError } from './errors.js';
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

/** The running computation of a store key; `reading` names the tags and versions it read before it began. */
interface Flight {
  readonly reading: string;
  readonly seq: number;
  readonly done: Promise<{ readonly bytes: Uint8Array }>;
}

const readingKey = (tags: readonly string[], reading: Reading): string => JSON.stringify([tags, reading.versions]);

const NOTHING_TO_FILL = async (): Promise<void> => undefined;

/** One named cache of a CacheService. A store failure is logged and read as a miss; misuse is thrown. */
export class NamedCache extends Cache {
  private opening: Promise<OpenedStore> | undefined;
  private openFailureLogged = false;
  private readonly inFlight = new Map<string, Flight>();
  private flights = 0;

  constructor(
    public readonly name: string,
    private readonly host: CacheHost,
  ) {
    super();
  }

  /** How many keys of this cache have a wrap() computation (a miss or a refresh) running in this process now. */
  public get computing(): number {
    return this.inFlight.size;
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
    if (found === undefined) return this.computeOnce(storeKey, options, life, compute);
    if (found.stale) this.refresh(storeKey, options, life, compute);
    return found.value;
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
    const opened = await this.opened().catch((error: unknown) => (error instanceof CacheConfigError ? this.unopenable(error) : this.failed('bump', error)));
    if (opened === undefined) return;
    await this.guard('bump', undefined, () => opened.store.bump(bumps));
  }

  private async opened(): Promise<OpenedStore> {
    return this.opening ?? this.open();
  }

  /** The opened store, undefined when opening it failed; a configuration error is thrown. */
  private async usable(): Promise<OpenedStore | undefined> {
    try {
      return await this.opened();
    } catch (error) {
      if (error instanceof CacheConfigError) throw error;
      return this.failed('open', error);
    }
  }

  private open(): Promise<OpenedStore> {
    const opening = this.host.openStore(this.name);
    this.opening = opening;
    // A failed opening is not kept: the next call opens again.
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
    const { maxTtlMs, ttlJitter } = this.host.config;
    const ttl = parseDuration(options.ttl, 'ttl');
    if (!(ttl > 0)) throw new InvalidArgument(`ttl must be above 0, got ${String(options.ttl)}`, 'ttl');
    // Shortened, never lengthened, so maxTtl stays a hard cap of ttl + swr.
    const ttlMs = Math.max(1, Math.round(Math.min(ttl, maxTtlMs) * (1 - Math.random() * ttlJitter)));
    return { ttlMs, swrMs: Math.min(parseDuration(options.swr ?? 0, 'swr'), maxTtlMs - ttlMs) };
  }

  /** A valid entry younger than ttl + swr, decoded; undefined otherwise. An undecodable entry is deleted. */
  private async read<T>(storeKey: string, options: CacheReadOptions): Promise<CacheHit<T> | undefined> {
    const opened = await this.usable();
    if (opened === undefined) return undefined;
    const { store, settings } = opened;
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
  private async produce<T>(storeKey: string, options: CacheOptions, life: Lifetime, compute: () => Promise<T>, reading: Reading | undefined, newest = (): boolean => true): Promise<Produced<T>> {
    const value = await compute();
    const bytes = encodeValue(value);
    // A computation a newer one replaced read versions a bump has moved since: its entry would only displace a valid one.
    if (reading !== undefined && newest()) await this.save(storeKey, bytes, options.tags ?? [], reading, life);
    return { value, bytes };
  }

  /** Joins the running computation of the key when it read the same versions, else starts one; a joiner decodes its own copy. */
  private async computeOnce<T>(storeKey: string, options: CacheOptions, life: Lifetime, compute: () => Promise<T>): Promise<T> {
    const reading = await this.versionsOf(options.tags ?? []);
    // Without versions nobody can tell whether a running computation began before a bump.
    if (reading === undefined) return (await this.produce(storeKey, options, life, compute, undefined)).value;
    const running = this.joinable(storeKey, options, reading);
    if (running !== undefined) return decodeValue<T>((await running.done).bytes);
    return (await this.launch(storeKey, options, life, compute, reading)).value;
  }

  /** Starts one background refresh of a stale key; a failure is logged and the stale entry stays until its window ends. */
  private refresh<T>(storeKey: string, options: CacheOptions, life: Lifetime, compute: () => Promise<T>): void {
    void this.refreshOnce(storeKey, options, life, compute).catch((error: unknown) => this.failed('refresh', error));
  }

  private async refreshOnce<T>(storeKey: string, options: CacheOptions, life: Lifetime, compute: () => Promise<T>): Promise<void> {
    const reading = await this.versionsOf(options.tags ?? []);
    if (reading === undefined || this.joinable(storeKey, options, reading) !== undefined) return;
    await this.launch(storeKey, options, life, compute, reading);
  }

  private joinable(storeKey: string, options: CacheOptions, reading: Reading): Flight | undefined {
    const running = this.inFlight.get(storeKey);
    return running?.reading === readingKey(options.tags ?? [], reading) ? running : undefined;
  }

  /** Makes this computation the key's running one, replacing an older one; only the running one stores its entry. */
  private launch<T>(storeKey: string, options: CacheOptions, life: Lifetime, compute: () => Promise<T>, reading: Reading): Promise<Produced<T>> {
    this.flights += 1;
    const seq = this.flights;
    // newest() runs only after compute() settled, by which time the flight below is in the map unless it was replaced or freed.
    const done = this.produce(storeKey, options, life, compute, reading, () => this.inFlight.get(storeKey)?.seq === seq);
    const flight: Flight = { reading: readingKey(options.tags ?? [], reading), seq, done };
    this.inFlight.set(storeKey, flight);
    const free = (): void => {
      if (this.inFlight.get(storeKey) === flight) this.inFlight.delete(storeKey);
    };
    void done.then(free, free);
    return done;
  }

  private async versionsOf(tags: readonly string[]): Promise<Reading | undefined> {
    const opened = await this.usable();
    if (opened === undefined) return undefined;
    const at = Date.now();
    const versions = await this.guard<readonly string[] | undefined>('versions', undefined, () => opened.store.versions(tags));
    return versions === undefined ? undefined : { versions, at };
  }

  private async save(storeKey: string, bytes: Uint8Array, tags: readonly string[], reading: Reading, life: Lifetime): Promise<void> {
    const opened = await this.usable();
    if (opened === undefined) return;
    const now = Date.now();
    // Counted from the reading, so maxTtl bounds every bump a store missed, however long the computation took.
    const left = this.host.config.maxTtlMs - (now - reading.at);
    if (left <= 0) return;
    const ttlMs = Math.min(life.ttlMs, left);
    const entry: CacheEntry = { value: bytes, tags, versions: reading.versions, storedAt: now, ttlMs, swrMs: Math.min(life.swrMs, left - ttlMs) };
    await this.guard('set', undefined, () => opened.store.set(storeKey, entry));
  }

  private async remove(storeKey: string): Promise<void> {
    const opened = await this.usable();
    if (opened !== undefined) await this.guard('delete', undefined, () => opened.store.delete(storeKey));
  }

  private async guard<R>(op: string, fallback: R, call: () => Promise<R>): Promise<R> {
    try {
      return await call();
    } catch (error) {
      this.failed(op, error);
      return fallback;
    }
  }

  private failed(op: string, error: unknown): undefined {
    const outcome = op === 'bump' ? 'entries of these tags may still be served from this store until they end' : 'read as a miss';
    cacheLog.warn({ cache: this.name, op, error }, `cache ${this.name}: ${op} failed; ${outcome}`);
    return undefined;
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
