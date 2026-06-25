import { InternalLogger } from '@spinajs/internal-logger';

/**
 * Default time (ms) a resolved secret / parameter is kept in memory before it is fetched again.
 * Can be overridden per protocol through `aws.secretsManager.cacheTtl` / `aws.parameterStore.cacheTtl`.
 * A value of `0` (or less) disables value caching while still deduplicating concurrent requests.
 */
export const DEFAULT_CACHE_TTL = 5 * 60 * 1000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Small in-memory cache with a per-entry TTL and concurrent request de-duplication.
 *
 * Two distinct config entries pointing at the same secret resolve to a single AWS call
 * (the in-flight promise is shared), and subsequent loads reuse the cached value until the
 * TTL elapses. The clock is injectable to keep the behaviour testable.
 */
export class TtlCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Returns the cached value for `key` when still fresh, otherwise invokes `factory` to obtain it.
   * Concurrent calls for the same key share a single `factory` invocation. Failures are never cached.
   *
   * @param key - cache key (should encode everything that influences the result eg. id + version)
   * @param ttl - time in ms the value stays fresh; `<= 0` disables caching but keeps de-duplication
   * @param factory - loader invoked on a cache miss
   */
  public async resolve(key: string, ttl: number, factory: () => Promise<unknown>): Promise<unknown> {
    if (ttl > 0) {
      const cached = this.entries.get(key);
      if (cached && cached.expiresAt > this.now()) {
        return cached.value;
      }
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const promise = (async () => {
      try {
        const value = await factory();
        if (ttl > 0) {
          this.entries.set(key, { value, expiresAt: this.now() + ttl });
        }
        return value;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    return promise;
  }

  /**
   * Drops all cached values and in-flight references.
   */
  public clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

/**
 * Result of parsing a protocol path eg. `my-secret?versionStage=AWSPREVIOUS#user.name`
 */
export interface ParsedAwsPath {
  /**
   * The secret / parameter identifier (everything before `?` or `#`).
   */
  id: string;

  /**
   * Query parameters used to tweak the request (eg. versionStage, withDecryption).
   */
  params: URLSearchParams;

  /**
   * Optional JSON path used to extract a single value from a JSON encoded secret.
   * Supports dot notation eg. `database.password`.
   */
  jsonPath?: string;
}

/**
 * Parses a protocol path into its identifier, query parameters and optional JSON path.
 *
 * AWS secret / parameter names never contain `?` or `#`, so they are safe delimiters.
 * Note: we do NOT use the standard `URL` parser here because it lowercases the host part,
 * and AWS secret names are case sensitive.
 *
 * @param raw - the path part of the protocol value (everything after `scheme://`)
 */
export function parseAwsPath(raw: string): ParsedAwsPath {
  let rest = raw;
  let jsonPath: string | undefined;
  let query = '';

  const hashIndex = rest.indexOf('#');
  if (hashIndex !== -1) {
    jsonPath = rest.substring(hashIndex + 1) || undefined;
    rest = rest.substring(0, hashIndex);
  }

  const queryIndex = rest.indexOf('?');
  if (queryIndex !== -1) {
    query = rest.substring(queryIndex + 1);
    rest = rest.substring(0, queryIndex);
  }

  return {
    id: rest,
    params: new URLSearchParams(query),
    jsonPath,
  };
}

/**
 * Outcome of evaluating a fallback for a failed fetch.
 */
export interface FallbackResult {
  /** whether a fallback applied and {@link FallbackResult.value} should be used */
  handled: boolean;
  /** the value to use when handled */
  value?: string;
}

/**
 * Decides what to return when an AWS fetch fails, based on opt-in query parameters:
 *  - `?default=<value>` returns the given literal value
 *  - `?optional=true` returns an empty string
 *
 * When neither is present the failure is not handled and the caller should rethrow. The fallback
 * applies to any error (including missing credentials, which is the common local-dev case) but a
 * warning is always logged so genuine misconfiguration (AccessDenied, throttling) stays visible.
 *
 * @param params - parsed query parameters of the protocol path
 * @param source - log source label
 * @param id - secret / parameter identifier (for the log message)
 * @param err - the error raised by the fetch
 */
export function resolveFallback(params: URLSearchParams, source: string, id: string, err: unknown): FallbackResult {
  const message = err instanceof Error ? err.message : String(err);

  if (params.has('default')) {
    InternalLogger.warn(`Could not resolve '${id}' (${err ? message : 'no value'}), using default value`, source);
    return { handled: true, value: params.get('default') ?? '' };
  }

  if (params.get('optional') === 'true') {
    InternalLogger.warn(`Could not resolve optional '${id}' (${message}), using empty string`, source);
    return { handled: true, value: '' };
  }

  return { handled: false };
}

/**
 * Warns (via {@link InternalLogger}) about any query parameter whose key is not in `allowed`.
 * Helps catch typos such as `?versionstage=` that would otherwise silently fall back to defaults.
 *
 * @param params - parsed query parameters
 * @param allowed - recognized parameter keys
 * @param source - log source label
 * @param id - secret / parameter identifier (for the log message)
 */
export function warnUnknownParams(params: URLSearchParams, allowed: string[], source: string, id: string): void {
  const allowedSet = new Set(allowed);
  for (const key of params.keys()) {
    if (!allowedSet.has(key)) {
      InternalLogger.warn(`Unknown query parameter '${key}' for '${id}' (${source}), ignoring it`, source);
    }
  }
}

/**
 * Parses a boolean query parameter accepting only `true` / `false`. A missing parameter returns
 * `fallback` silently; any other value logs a warning and falls back.
 *
 * @param params - parsed query parameters
 * @param key - parameter key to read
 * @param fallback - value used when the parameter is missing or invalid
 * @param source - log source label
 */
export function parseBoolParam(params: URLSearchParams, key: string, fallback: boolean, source: string): boolean {
  if (!params.has(key)) {
    return fallback;
  }

  const value = params.get(key);
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }

  InternalLogger.warn(`Invalid value '${value ?? ''}' for query parameter '${key}', expected 'true' or 'false'; using ${String(fallback)}`, source);
  return fallback;
}

/**
 * Reads a value from an object following a dot separated path eg. `a.b.c`.
 */
function getByPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) {
      return undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Assigns `value` into `target` following a list of nested keys, creating intermediate
 * objects as needed eg. `assignNested(o, ['db', 'host'], 'h')` -> `o.db.host === 'h'`.
 *
 * Used to turn flat Parameter Store hierarchies (`db/host`, `db/port`) into a nested config object.
 */
export function assignNested(target: Record<string, unknown>, keys: string[], value: unknown): void {
  let node = target;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (typeof node[key] !== 'object' || node[key] === null) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * Resolves the final config value from a raw secret/parameter value.
 *
 * When `jsonPath` is provided the value is parsed as JSON and the requested key is returned,
 * otherwise the raw value is returned unchanged.
 *
 * @param value - raw value obtained from AWS (string, Buffer or undefined)
 * @param jsonPath - optional dot separated path to extract from a JSON encoded value
 */
export function extractValue(value: string | Buffer | undefined, jsonPath?: string): unknown {
  if (value === undefined) {
    return value;
  }

  if (!jsonPath) {
    return value;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString());
  } catch (err) {
    throw new Error(`Cannot extract '${jsonPath}': value is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return getByPath(parsed, jsonPath);
}

/**
 * Builds an AWS SDK compatible logger that forwards to {@link InternalLogger}.
 *
 * @param source - the log source label eg. `AwsSecretsManagerVarProtocol`
 */
export function createSdkLogger(source: string) {
  return {
    trace: (msg: unknown) => InternalLogger.trace(msg as string, source),
    debug: (msg: unknown) => InternalLogger.debug(msg as string, source),
    info: (msg: unknown) => InternalLogger.info(msg as string, source),
    warn: (msg: unknown) => InternalLogger.warn(msg as string, source),
    error: (msg: unknown) => InternalLogger.error(msg as string, source),
  };
}
