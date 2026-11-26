import { parseDuration } from '@spinajs/cache';
import { InvalidArgument } from '@spinajs/exceptions';
import { FIELD_NAME_PATTERN } from '@spinajs/http';

/** Who shares a stored reply: the principal that asked (default), every principal of the tenant, or everyone. */
export type ResponseCacheScope = 'principal' | 'tenant' | 'shared';

export interface ResponseCacheOptions {
  /** How long a stored reply is served: milliseconds or a duration such as '5m'; above 0, capped by cache.maxTtl. */
  readonly ttl: number | string;
  readonly scope?: ResponseCacheScope;
  /** Required with scope 'tenant' or 'shared', refused otherwise: why the reply is the same for every caller who gets it. */
  readonly sharedBecause?: string;
  /** Request headers whose values are part of the key, besides the URL and Accept. */
  readonly vary?: readonly string[];
  /** Tags the reply depends on: invalidating one of them drops it. */
  readonly tags?: readonly string[];
  /** The named cache that keeps the replies (cache.caches.<name>); 'default' when absent. */
  readonly cache?: string;
}

export interface ResolvedResponseCacheOptions {
  readonly ttl: number | string;
  readonly scope: ResponseCacheScope;
  /** Trimmed; present exactly when the scope is 'tenant' or 'shared'. */
  readonly sharedBecause?: string;
  /** Lower case, once each, sorted. */
  readonly vary: readonly string[];
  readonly tags: readonly string[];
  readonly cache: string;
}

const OPTIONS: ReadonlySet<string> = new Set(['ttl', 'scope', 'sharedBecause', 'vary', 'tags', 'cache']);
const SCOPES: ReadonlySet<unknown> = new Set(['principal', 'tenant', 'shared']);

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

function texts(value: unknown, option: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    const list: unknown[] = value;
    if (list.every(isText)) return list;
  }
  throw new InvalidArgument(`@ResponseCache ${option} must be a list of non-empty strings, got ${JSON.stringify(value)}`);
}

function aboveZero(ttl: unknown): boolean {
  return (typeof ttl === 'number' || typeof ttl === 'string') && parseDuration(ttl, '@ResponseCache ttl') > 0;
}

/** The trimmed reason of a tenant or shared scope; a wider scope without one, or a reason on the default scope, throws. */
function sharedReason(scope: ResponseCacheScope, given: unknown): string | undefined {
  if (scope === 'principal') {
    if (given !== undefined) throw new InvalidArgument("@ResponseCache sharedBecause goes with scope 'tenant' or 'shared'");
    return undefined;
  }
  const reason = typeof given === 'string' ? given.trim() : '';
  if (reason === '') {
    throw new InvalidArgument(`@ResponseCache scope '${scope}' gives one stored reply to many callers: say why it is the same for all of them, for example sharedBecause: 'the price list is public'`);
  }
  return reason;
}

function varyNames(value: unknown): string[] {
  const names = texts(value, 'vary').map((name) => name.toLowerCase());
  if (names.some((name) => name === '*' || !FIELD_NAME_PATTERN.test(name))) {
    throw new InvalidArgument(`@ResponseCache vary must be a list of request header names, got ${JSON.stringify(value)}`);
  }
  return [...new Set(names)].sort();
}

/** Checks the options of `@ResponseCache` where it is written, so a wrong one fails at import. */
export function resolveResponseCacheOptions(options: ResponseCacheOptions): ResolvedResponseCacheOptions {
  const given: unknown = options;
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new InvalidArgument(`@ResponseCache options must be an object, got ${JSON.stringify(given)}`);
  }
  const unknown = Object.keys(given).filter((name) => !OPTIONS.has(name));
  if (unknown.length > 0) {
    throw new InvalidArgument(`@ResponseCache has no option ${unknown.join(', ')}`);
  }
  const { ttl, scope = 'principal', cache = 'default' } = options;
  if (!aboveZero(ttl)) {
    throw new InvalidArgument(`@ResponseCache ttl must be a duration above 0 such as '5m', got ${JSON.stringify(ttl)}`);
  }
  if (!SCOPES.has(scope)) {
    throw new InvalidArgument(`@ResponseCache scope must be 'principal', 'tenant' or 'shared', got ${JSON.stringify(scope)}`);
  }
  const sharedBecause = sharedReason(scope, options.sharedBecause);
  const vary = varyNames(options.vary);
  if (!isText(cache)) {
    throw new InvalidArgument(`@ResponseCache cache must be the name of a cache, got ${JSON.stringify(cache)}`);
  }
  return Object.freeze({ ttl, scope, ...(sharedBecause === undefined ? {} : { sharedBecause }), vary, tags: texts(options.tags, 'tags'), cache });
}
