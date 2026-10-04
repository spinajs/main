import { normalizeEnvironment } from '@spinajs/configuration-common';

export const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Development and test relax https and cookie flags; an absent or unknown env is production. */
export function isRelaxedEnv(env: string | null | undefined): boolean {
  const normalized = normalizeEnvironment(env);
  return normalized === 'dev' || normalized === 'test';
}

export interface UrlRules {
  /** http allowed too (development and test). */
  readonly relaxed: boolean;
  readonly query?: boolean;
}

/**
 * The URL when `value` is an absolute https (or, relaxed, http) URL without credentials or fragment; else null.
 * Whitespace and backslashes are refused before parsing, because the WHATWG parser silently trims or rewrites them.
 */
export function checkedUrl(value: unknown, rules: UrlRules): URL | null {
  if (typeof value !== 'string' || value.length === 0 || /[\s\\]/.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const schemeOk = url.protocol === 'https:' || (rules.relaxed && url.protocol === 'http:');
  if (!schemeOk || url.username !== '' || url.password !== '' || value.includes('#') || (!rules.query && value.includes('?'))) {
    return null;
  }
  return url;
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) {
      deepFreeze(v);
    }
  }
  return value;
}
