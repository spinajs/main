import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import { CacheStore } from './contracts.js';
import type { CacheSettings } from './contracts.js';
import { parseDuration } from './duration.js';
import { CacheConfigError } from './errors.js';

export const DEFAULT_CACHE = 'default';

/** What applies where cache.* leaves a key unset; the schema defaults say the same for a validated configuration. */
export const CACHE_DEFAULTS = Object.freeze({ maxTtl: '1h', ttlJitter: 0.1, store: 'MemoryCacheStore', maxEntries: 50_000, maxBytes: 134_217_728, breakerFailures: 5, breakerResetAfter: '10s' });

export interface CacheConfig {
  readonly maxTtlMs: number;
  readonly ttlJitter: number;
  readonly breakerFailures: number;
  readonly breakerResetMs: number;
  readonly caches: Readonly<Partial<Record<string, Readonly<Record<string, unknown>>>>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const timeOf = (value: unknown, fallback: string, field: string): number => parseDuration(typeof value === 'string' || typeof value === 'number' ? value : fallback, field);
const numberOf = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** Read once, when the CacheService resolves. */
export function readCacheConfig(configuration: Configuration): CacheConfig {
  const root = configuration.get<unknown>(['cache']);
  const section: Record<string, unknown> = isRecord(root) ? root : {};
  const entries = isRecord(section.caches) ? Object.entries(section.caches) : [];
  const caches = Object.fromEntries(entries.flatMap(([name, entry]) => (isRecord(entry) ? [[name, entry] as const] : [])));
  const breaker: Record<string, unknown> = isRecord(section.breaker) ? section.breaker : {};
  return {
    maxTtlMs: timeOf(section.maxTtl, CACHE_DEFAULTS.maxTtl, 'cache.maxTtl'),
    ttlJitter: numberOf(section.ttlJitter, CACHE_DEFAULTS.ttlJitter),
    breakerFailures: numberOf(breaker.failures, CACHE_DEFAULTS.breakerFailures),
    breakerResetMs: timeOf(breaker.resetAfter, CACHE_DEFAULTS.breakerResetAfter, 'cache.breaker.resetAfter'),
    caches,
  };
}

/** Only the cache `default` exists without an entry in cache.caches. */
export function cacheSettings(config: CacheConfig, name: string): CacheSettings {
  // Own keys only: a name such as 'constructor' must not find a member of Object.prototype.
  const raw = Object.entries(config.caches).find(([configured]) => configured === name)?.[1];
  if (raw === undefined && name !== DEFAULT_CACHE) throw new CacheConfigError(`cache '${name}' is not configured; add it under cache.caches.${name}`);
  const own = raw ?? {};
  return {
    name,
    store: typeof own.store === 'string' ? own.store : CACHE_DEFAULTS.store,
    maxEntries: numberOf(own.maxEntries, CACHE_DEFAULTS.maxEntries),
    maxBytes: numberOf(own.maxBytes, CACHE_DEFAULTS.maxBytes),
    maxTtlMs: config.maxTtlMs,
    consistency: own.consistency === 'strict' ? 'strict' : 'eventual',
    breakerFailures: config.breakerFailures,
    breakerResetMs: config.breakerResetMs,
    raw: own,
  };
}

/** The CacheStore registered under `name`; every call gives a new instance (stores are `@NewInstance()`). */
export async function resolveStore(container: IContainer, name: string, path: string): Promise<CacheStore> {
  const registered = container.getRegisteredNames(CacheStore);
  if (!registered.includes(name)) {
    throw new CacheConfigError(`${path} '${name}': no CacheStore is registered under that name (registered: ${registered.join(', ') || 'none'})`);
  }
  return container.resolveNamed(CacheStore, name);
}
