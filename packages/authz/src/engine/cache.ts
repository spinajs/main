import type { Decision } from '../contracts/decision.js';
import { AuthzConfigError } from '../contracts/errors.js';
import { DecisionCache } from '../contracts/service.js';

interface Entry {
  readonly decision: Decision;
  readonly tags: ReadonlySet<string>;
  readonly expiresAt: number;
}

export interface LruDecisionCacheOptions {
  readonly maxEntries?: number;
  readonly clock?: () => Date;
}

export class LruDecisionCache extends DecisionCache {
  // Map iteration order is insertion order: the first key is the least recent.
  private readonly entries = new Map<string, Entry>();
  private readonly byTag = new Map<string, Set<string>>();
  private readonly maxEntries: number;
  private readonly clock: () => Date;

  constructor(options: LruDecisionCacheOptions = {}) {
    super();
    const maxEntries = options.maxEntries ?? 10000;
    if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new AuthzConfigError(`LruDecisionCache: maxEntries must be an integer >= 1, got ${String(maxEntries)}`);
    }
    this.maxEntries = maxEntries;
    this.clock = options.clock ?? (() => new Date());
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): Decision | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    const now = this.now();
    this.entries.delete(key);
    if (!(now < entry.expiresAt)) {
      this.unindex(key, entry);
      return undefined;
    }
    this.entries.set(key, entry);
    return entry.decision;
  }

  set(key: string, d: Decision, tags: readonly string[], ttlMs: number): void {
    this.remove(key);
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const now = this.now();
    // An invalid clock date gives a NaN deadline; such an entry could never hit.
    if (!Number.isFinite(now)) return;
    const entry: Entry = { decision: d, tags: new Set(tags), expiresAt: now + ttlMs };
    this.entries.set(key, entry);
    for (const tag of entry.tags) {
      let keys = this.byTag.get(tag);
      if (keys === undefined) this.byTag.set(tag, (keys = new Set()));
      keys.add(key);
    }
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.remove(oldest);
    }
  }

  invalidate(tags: readonly string[]): void {
    for (const tag of tags) {
      const keys = this.byTag.get(tag);
      if (keys === undefined) continue;
      for (const key of [...keys]) this.remove(key);
    }
  }

  private now(): number {
    return this.clock().getTime();
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.unindex(key, entry);
  }

  private unindex(key: string, entry: Entry): void {
    for (const tag of entry.tags) {
      const keys = this.byTag.get(tag);
      if (keys === undefined) continue;
      keys.delete(key);
      if (keys.size === 0) this.byTag.delete(tag);
    }
  }
}
