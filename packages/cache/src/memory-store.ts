import { randomBytes } from 'node:crypto';
import { Injectable, NewInstance } from '@spinajs/di';
import { LruTtlCache } from '@spinajs/util';
import type { Clock } from '@spinajs/util';
import { CacheStore } from './contracts.js';
import type { CacheEntry, CacheSettings, CacheStoreRead, TagBump } from './contracts.js';

export interface MemoryCacheStoreOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxTtlMs?: number;
  /** How many tag versions are kept, also after configure(); default 4 * maxEntries. Dropping one early costs misses only. */
  readonly maxTags?: number;
  readonly clock?: Clock;
}

interface TagVersion {
  readonly version: string;
  /** When the version was last handed out or set by a bump. */
  readonly at: number;
}

/**
 * Entries in an LruTtlCache bounded by count and bytes, tag versions in a map. A version is a token of this store (a
 * random id of the instance and a counter), so no store hands one out twice; a tag without a version gets a new token,
 * and an entry that holds a version the store no longer has is invalid.
 */
@NewInstance()
@Injectable(CacheStore)
export class MemoryCacheStore extends CacheStore {
  private entries: LruTtlCache<string, CacheEntry>;
  private readonly tagVersions = new Map<string, TagVersion>();
  private readonly id = randomBytes(6).toString('base64url');
  private counter = 0;
  private bumpsApplied = 0;
  private maxTtlMs: number;
  private maxTags: number;
  private clock: Clock | undefined;
  private readonly givenMaxTags: number | undefined;

  constructor(options: MemoryCacheStoreOptions = {}) {
    super();
    this.givenMaxTags = options.maxTags;
    this.open(options);
  }

  /** Changes with every bump; a tiered store compares it around a read of its lower tier. */
  public get epoch(): number {
    return this.bumpsApplied;
  }

  public async configure(settings: CacheSettings): Promise<void> {
    this.open({ maxEntries: settings.maxEntries, maxBytes: settings.maxBytes, maxTtlMs: settings.maxTtlMs, maxTags: this.givenMaxTags, clock: this.clock });
  }

  public async get(key: string): Promise<CacheStoreRead | undefined> {
    return this.read(key);
  }

  public async set(key: string, entry: CacheEntry): Promise<void> {
    this.write(key, entry);
  }

  public async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  public async versions(tags: readonly string[]): Promise<readonly string[]> {
    return this.versionsNow(tags);
  }

  public async bump(bumps: readonly TagBump[]): Promise<void> {
    this.bumpNow(bumps);
  }

  /** get() without a promise; an invalid entry is dropped as it is read. A tag without a version never matches, and an entry must hold exactly one version per tag. */
  public read(key: string): CacheStoreRead | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    const valid =
      entry.tags.length === entry.versions.length &&
      entry.tags.every((tag, i) => {
        const held = this.tagVersions.get(tag)?.version;
        return held !== undefined && held === entry.versions.at(i);
      });
    if (!valid) this.entries.delete(key);
    return { entry, valid };
  }

  public write(key: string, entry: CacheEntry): void {
    const ttlMs = Math.min(entry.ttlMs + entry.swrMs, this.maxTtlMs);
    this.entries.set(key, entry, { ttlMs, weight: entry.value.byteLength + key.length * 2 });
  }

  public versionsNow(tags: readonly string[]): string[] {
    const now = this.now();
    const versions = tags.map((tag) => this.keep(tag, this.tagVersions.get(tag)?.version ?? this.token(), now));
    this.forget(now);
    return versions;
  }

  public bumpNow(bumps: readonly TagBump[]): void {
    if (bumps.length > 0) this.bumpsApplied += 1;
    const now = this.now();
    for (const { tag } of bumps) this.keep(tag, this.token(), now);
    this.forget(now);
  }

  // Re-inserted, so the map stays ordered by last use and forget() stops at the first version still in use.
  private keep(tag: string, version: string, now: number): string {
    this.tagVersions.delete(tag);
    this.tagVersions.set(tag, { version, at: now });
    return version;
  }

  private token(): string {
    this.counter += 1;
    return `${this.id}.${this.counter.toString(36)}`;
  }

  // Dropping a version only makes the entries that hold it misses, so the map is bounded by age and by count.
  private forget(now: number): void {
    for (const [tag, { at }] of this.tagVersions) {
      if (now - at < this.maxTtlMs && this.tagVersions.size <= this.maxTags) return;
      this.tagVersions.delete(tag);
    }
  }

  private open(options: MemoryCacheStoreOptions): void {
    const maxEntries = options.maxEntries ?? 50_000;
    this.maxTtlMs = options.maxTtlMs ?? 3_600_000;
    this.maxTags = options.maxTags ?? maxEntries * 4;
    this.clock = options.clock;
    this.entries = new LruTtlCache<string, CacheEntry>({ maxEntries, maxWeight: options.maxBytes ?? 134_217_728, clock: options.clock });
  }

  private now(): number {
    return this.clock ? this.clock.now().getTime() : Date.now();
  }
}
