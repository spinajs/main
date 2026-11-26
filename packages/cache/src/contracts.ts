import type { IContainer } from '@spinajs/di';

export type CacheLayer = 'app' | 'orm' | 'http';
export type CacheConsistency = 'eventual' | 'strict';

export interface CacheReadOptions {
  /** Overrides the cache's configured consistency for this call; only a tiered store tells the two apart. */
  readonly consistency?: CacheConsistency;
  /** The `layer` label of this call's metrics; default 'app'. */
  readonly layer?: CacheLayer;
}

export interface CacheOptions extends CacheReadOptions {
  /** Milliseconds or a duration such as '5m'; above 0, capped by cache.maxTtl. */
  readonly ttl: number | string;
  /** How long after `ttl` a stale value is still served (by wrap(), which refreshes it in the background, and by lookup() as a stale hit); default 0. */
  readonly swr?: number | string;
  /** The entry is valid while none of these tags was bumped after its value began to be computed. */
  readonly tags?: readonly string[];
}

export interface CacheHit<T> {
  readonly hit: true;
  readonly value: T;
  /** Past its ttl, inside its swr window. */
  readonly stale: boolean;
  /**
   * On a stale hit only: stores `value` under the tag versions read before this hit was answered, like the fill of a
   * miss. It claims nothing; the stale entry stays until a write replaces it.
   */
  fill?(value: T): Promise<void>;
}

export interface CacheMiss<T> {
  readonly hit: false;
  /** Stores `value` under the tag versions read before this miss was answered, so a bump in between leaves it invalid. */
  fill(value: T): Promise<void>;
}

export type CacheLookup<T> = CacheHit<T> | CacheMiss<T>;

export abstract class Cache {
  abstract readonly name: string;

  /** A fresh value; undefined on a miss, past the ttl, or for a stored undefined. */
  abstract get<T>(key: string, options?: CacheReadOptions): Promise<T | undefined>;

  /** Stores under the tag versions of this moment; for a value read earlier use wrap() or lookup(). */
  abstract set<T>(key: string, value: T, options: CacheOptions): Promise<void>;

  /**
   * The cached value, else compute(), run once per key and tag versions in this process; a stale value is served while
   * one refresh runs. A caller never joins a computation that began before an invalidation of one of its tags.
   */
  abstract wrap<T>(key: string, options: CacheOptions, compute: () => Promise<T>): Promise<T>;

  /** A fresh or stale hit, or a miss; a miss and a stale hit can be filled later with the versions read now. */
  abstract lookup<T>(key: string, options: CacheOptions): Promise<CacheLookup<T>>;

  abstract delete(key: string, options?: CacheReadOptions): Promise<void>;

  /** Bumps the tags in every cache of this process and publishes the bumps. */
  abstract invalidate(tags: readonly string[], options?: CacheReadOptions): Promise<void>;
}

export interface CacheEntry {
  readonly value: Uint8Array;
  readonly tags: readonly string[];
  /** The versions `tags` had before the value was computed, in the same order. */
  readonly versions: readonly string[];
  /** The time of the write; ttlMs + swrMs end at most maxTtl after the versions were read. */
  readonly storedAt: number;
  readonly ttlMs: number;
  readonly swrMs: number;
}

export interface TagBump {
  readonly tag: string;
  /** The stamp of the bump (stampBumps); stores do not compare it. */
  readonly version: string;
}

export interface CacheStoreReadOptions {
  readonly consistency?: CacheConsistency;
}

export interface CacheStoreRead {
  readonly entry: CacheEntry;
  /** Every version the entry holds is still current. */
  readonly valid: boolean;
}

/** The settings of one cache, handed to its store. */
export interface CacheSettings {
  readonly name: string;
  readonly store: string;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly maxTtlMs: number;
  readonly consistency: CacheConsistency;
  /** Every key of cache.caches.<name>, those of the store included. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * A version is a token the store never handed out before. A store may lose a version (forget, evict, restart): the
 * tag then gets a new token, and an entry holding the lost one is invalid. A missing version never matches.
 */
export abstract class CacheStore {
  /** The entry, valid only while the store holds exactly the version the entry has for each tag; undefined when absent or expired. */
  abstract get(key: string, options?: CacheStoreReadOptions): Promise<CacheStoreRead | undefined>;

  abstract set(key: string, entry: CacheEntry): Promise<void>;

  abstract delete(key: string): Promise<void>;

  /** Current versions in the order of `tags`, a new token for a tag without one; never empty, never containing '|'. */
  abstract versions(tags: readonly string[]): Promise<readonly string[]>;

  /** Gives every tag a new token; applying a bump twice only costs a miss. */
  abstract bump(bumps: readonly TagBump[]): Promise<void>;

  /** Called once, right after the store is created for a cache. */
  public async configure(_settings: CacheSettings, _container: IContainer): Promise<void> {}
}

/** Segments added to every key; the tenancy package registers the tenant. Returning null means "do not cache here". */
export abstract class CacheScope {
  abstract segments(): readonly string[] | null;
}
