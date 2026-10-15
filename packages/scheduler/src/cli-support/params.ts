import { InvalidRunParams } from '../contract.js';

/** Commander accumulator for repeatable options. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** `--params '<json object>'` merged with repeated `--param key=value`; the schedule's schema coerces the strings. */
export function parseParams(json?: string, pairs: string[] = []): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  if (json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      throw new InvalidRunParams(`--params is not valid JSON: ${(err as Error).message}`, [
        { path: '', message: 'invalid JSON' },
      ]);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidRunParams('--params must be a JSON object', [{ path: '', message: 'expected an object' }]);
    }
    out = { ...(parsed as Record<string, unknown>) };
  }
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i <= 0) {
      throw new InvalidRunParams(`--param '${pair}' must look like key=value`, [
        { path: '', message: 'expected key=value' },
      ]);
    }
    (out ??= {})[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export function parseLimit(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === 'number' ? value : /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidRunParams(`--limit must be a positive integer, got '${value}'`, [
      { path: '/limit', message: 'must be a positive integer' },
    ]);
  }
  return n;
}

/** The service treats an unknown status filter as "matches nothing"; on the command line it is a typo. */
export function oneOf<T extends string>(
  field: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidRunParams(`--${field} must be one of ${allowed.join(', ')}, got '${value}'`, [
      { path: `/${field}`, message: `must be one of ${allowed.join(', ')}` },
    ]);
  }
  return value as T;
}
