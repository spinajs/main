import { InvalidArgument } from '@spinajs/exceptions';

import type { Clock } from './clock.js';

/** Why an entry left an {@link LruTtlCache}. */
export type LruTtlEvictReason = 'expired' | 'capacity' | 'replaced' | 'invalidated' | 'deleted' | 'cleared';

export interface LruTtlCacheOptions<K, V> {
  /** Entries held at most; the least recently used goes first. 0 holds nothing. */
  readonly maxEntries: number;

  /** TTL of an entry set without one. Omitted: such entries never expire. */
  readonly ttlMs?: number;

  /** Times the TTL. Default: the wall clock. */
  readonly clock?: Clock;

  /** Treat an entry stored at a later clock time than now ( the clock went back ) as expired. */
  readonly expireOnClockRewind?: boolean;

  /** Called for every entry that leaves the cache. */
  readonly onEvict?: (key: K, value: V, reason: LruTtlEvictReason) => void;
}

export interface LruTtlSetOptions {
  /** Overrides the cache TTL. Not a finite number above 0: the entry is not stored. */
  readonly ttlMs?: number;

  /** {@link LruTtlCache.invalidate} with any of these drops the entry. */
  readonly tags?: Iterable<string>;
}

interface Entry<V> {
  readonly value: V;
  readonly tags: ReadonlySet<string>;
  readonly storedAt: number;
  readonly expiresAt: number;
}

/** A least-recently-used cache whose entries expire after a TTL and can be dropped by tag. */
export class LruTtlCache<K, V> {
  // Map iteration order is insertion order: the first key is the least recent.
  private readonly entries = new Map<K, Entry<V>>();
  private readonly byTag = new Map<string, Set<K>>();
  private readonly maxEntries: number;

  constructor(private readonly options: LruTtlCacheOptions<K, V>) {
    const max = options.maxEntries;
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
      throw new InvalidArgument(`LruTtlCache: maxEntries must be an integer >= 0, got ${String(max)}`, 'maxEntries');
    }
    this.maxEntries = max;
  }

  /** Entries held, including expired ones not yet read. */
  get size(): number {
    return this.entries.size;
  }

  /** The live value under `key`, marked as the most recently used. */
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    if (this.expired(entry, this.now())) {
      this.unindex(key, entry);
      this.options.onEvict?.(key, entry.value, 'expired');
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  /** The live value under `key`, without changing the recency order or dropping an expired entry. */
  peek(key: K): V | undefined {
    const entry = this.entries.get(key);
    return entry === undefined || this.expired(entry, this.now()) ? undefined : entry.value;
  }

  has(key: K): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && !this.expired(entry, this.now());
  }

  set(key: K, value: V, options: LruTtlSetOptions = {}): void {
    this.remove(key, 'replaced');
    if (this.maxEntries === 0) return;
    const ttlMs = options.ttlMs ?? this.options.ttlMs;
    if (ttlMs !== undefined && (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0)) return;
    const now = this.now();
    // An invalid clock date gives a NaN deadline; such an entry could never hit.
    if (!Number.isFinite(now)) return;
    const entry: Entry<V> = { value, tags: new Set(options.tags ?? []), storedAt: now, expiresAt: ttlMs === undefined ? Number.POSITIVE_INFINITY : now + ttlMs };
    this.entries.set(key, entry);
    for (const tag of entry.tags) {
      let keys = this.byTag.get(tag);
      if (keys === undefined) this.byTag.set(tag, (keys = new Set()));
      keys.add(key);
    }
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.remove(oldest, 'capacity');
    }
  }

  delete(key: K): boolean {
    return this.remove(key, 'deleted');
  }

  /** Drops every entry tagged with any of `tags`. */
  invalidate(tags: Iterable<string>): void {
    for (const tag of tags) {
      const keys = this.byTag.get(tag);
      if (keys === undefined) continue;
      for (const key of [...keys]) this.remove(key, 'invalidated');
    }
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.remove(key, 'cleared');
  }

  private now(): number {
    return this.options.clock ? this.options.clock.now().getTime() : Date.now();
  }

  private expired(entry: Entry<V>, now: number): boolean {
    return !(now < entry.expiresAt) || (this.options.expireOnClockRewind === true && now < entry.storedAt);
  }

  private remove(key: K, reason: LruTtlEvictReason): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    this.unindex(key, entry);
    this.options.onEvict?.(key, entry.value, reason);
    return true;
  }

  private unindex(key: K, entry: Entry<V>): void {
    for (const tag of entry.tags) {
      const keys = this.byTag.get(tag);
      if (keys === undefined) continue;
      keys.delete(key);
      if (keys.size === 0) this.byTag.delete(tag);
    }
  }
}

/**
 * A map holding at most `max` entries: setting a new key when full drops the oldest one. Setting a key already held
 * keeps its place. Bounds maps keyed by request data.
 */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly max: number) {
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) {
      throw new InvalidArgument(`BoundedMap: max must be an integer >= 1, got ${String(max)}`, 'max');
    }
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    if (!this.map.has(key) && this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, value);
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
