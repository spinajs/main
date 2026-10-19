import { LruTtlCache } from '@spinajs/util';

import type { Decision } from '../contracts/decision.js';
import { AuthzConfigError } from '../contracts/errors.js';
import { DecisionCache } from '../contracts/service.js';

export interface LruDecisionCacheOptions {
  readonly maxEntries?: number;
  readonly clock?: () => Date;
}

export class LruDecisionCache extends DecisionCache {
  private readonly entries: LruTtlCache<string, Decision>;

  constructor(options: LruDecisionCacheOptions = {}) {
    super();
    const maxEntries = options.maxEntries ?? 10000;
    if (typeof maxEntries !== 'number' || !Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new AuthzConfigError(`LruDecisionCache: maxEntries must be an integer >= 1, got ${String(maxEntries)}`);
    }
    const clock = options.clock ?? (() => new Date());
    this.entries = new LruTtlCache({ maxEntries, clock: { now: () => clock() } });
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): Decision | undefined {
    return this.entries.get(key);
  }

  set(key: string, d: Decision, tags: readonly string[], ttlMs: number): void {
    // LruTtlCache reads a missing TTL as "never expires"; here it means "do not store".
    if (typeof ttlMs !== 'number') {
      this.entries.delete(key);
      return;
    }
    this.entries.set(key, d, { tags, ttlMs });
  }

  invalidate(tags: readonly string[]): void {
    this.entries.invalidate(tags);
  }
}
