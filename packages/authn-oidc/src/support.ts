import { normalizeEnvironment } from '@spinajs/configuration-common';
import { _custom, _is_string, _non_empty, _try_check_arg } from '@spinajs/util';

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
 * Control characters, spaces and backslashes are refused before parsing, because the WHATWG parser silently drops or
 * rewrites them, and callers use the raw string.
 */
export function checkedUrl(value: unknown, rules: UrlRules): URL | null {
  const [ok, text] = _try_check_arg(_is_string(_non_empty(), _custom((s: string) => !/[\x00-\x20\x7f\\]/.test(s))))(value, 'value');
  if (!ok) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const schemeOk = url.protocol === 'https:' || (rules.relaxed && url.protocol === 'http:');
  if (!schemeOk || url.username !== '' || url.password !== '' || text.includes('#') || (!rules.query && text.includes('?'))) {
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
