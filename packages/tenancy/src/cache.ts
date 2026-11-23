import { TenantRegistry } from './contracts.js';
import type { TenantRecord, TenantState } from './contracts.js';

const MAX_ENTRIES = 10_000;

interface Cached<T> {
  readonly value: T;
  readonly until: number;
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T, until: number): void {
  // Unknown ids, hosts and slugs come from outside; the cache must not grow with them.
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { value, until });
}

/** Caches `get` and `find` of a cacheable registry, misses included, for `ttlMs()` milliseconds. `list` is never cached. */
export class CachedTenantRegistry extends TenantRegistry {
  private readonly records = new Map<string, Cached<TenantRecord | undefined>>();

  private readonly lookups = new Map<string, Cached<string | undefined>>();

  // A lookup still running when invalidate() is called must not store what it read before.
  private generation = 0;

  constructor(
    public readonly inner: TenantRegistry,
    private readonly ttlMs: () => number,
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
  }

  public override get cacheable(): boolean {
    return false;
  }

  public async get(id: string): Promise<TenantRecord | undefined> {
    const ttl = this.ttl();
    if (ttl === 0) return this.inner.get(id);

    const started = this.now();
    const hit = this.records.get(id);
    if (hit && hit.until > started) return hit.value;

    const generation = this.generation;
    const record = await this.inner.get(id);
    if (generation === this.generation) remember(this.records, id, record, started + ttl);
    return record;
  }

  public async find(by: { slug?: string; domain?: string }): Promise<TenantRecord | undefined> {
    const ttl = this.ttl();
    if (ttl === 0) return this.inner.find(by);

    const key = JSON.stringify([by.slug ?? null, by.domain?.toLowerCase() ?? null]);
    const started = this.now();
    const hit = this.lookups.get(key);
    if (hit && hit.until > started) return hit.value === undefined ? undefined : this.get(hit.value);

    const generation = this.generation;
    const record = await this.inner.find(by);
    if (generation !== this.generation) return record;
    remember(this.lookups, key, record?.id, started + ttl);
    if (record) remember(this.records, record.id, record, started + ttl);
    return record;
  }

  public list(filter?: { states?: TenantState[] }): AsyncIterable<TenantRecord> {
    return this.inner.list(filter);
  }

  /** Forgets one tenant and every remembered miss, or everything. Call it after a tenant was created or changed. */
  public invalidate(id?: string): void {
    this.generation += 1;
    if (id === undefined) {
      this.records.clear();
      this.lookups.clear();
      return;
    }
    this.records.delete(id);
    for (const [key, hit] of this.lookups) {
      if (hit.value === id || hit.value === undefined) this.lookups.delete(key);
    }
  }

  private ttl(): number {
    const ttl = this.inner.cacheable ? this.ttlMs() : 0;
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
  }
}
