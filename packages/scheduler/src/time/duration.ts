import { InvalidArgument } from '@spinajs/exceptions';

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DURATION = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/i;

export function parseDuration(value: number | string, field = 'duration'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new InvalidArgument(`${field} must be a non-negative number of milliseconds, got ${value}`);
    }
    return value;
  }

  const m = DURATION.exec(value);
  if (!m) {
    throw new InvalidArgument(`${field}: cannot parse duration '${value}' (use e.g. 500ms, 10s, 5m, 2h, 30d, 1w)`);
  }

  return Math.round(parseFloat(m[1]) * UNIT_MS[m[2].toLowerCase()]);
}
