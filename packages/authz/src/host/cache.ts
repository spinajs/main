import { DI } from '@spinajs/di';
import { DecisionCache } from '../contracts/service.js';
import { LruDecisionCache } from '../engine/cache.js';
import type { LruDecisionCacheOptions } from '../engine/cache.js';

// Factories are never cached: each resolve gives one cache per domain.
DI.register((_c, opts?: LruDecisionCacheOptions) => new LruDecisionCache(opts ?? {})).as(DecisionCache);
