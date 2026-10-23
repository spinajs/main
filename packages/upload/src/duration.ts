import { InvalidArgument } from '@spinajs/exceptions';

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** The units of the scheduler's durations (scheduler/src/time/duration.ts:3-4); upload cannot import them, the scheduler is an optional peer. */
export const DURATION_PATTERN = '^(\\d+(?:\\.\\d+)?)(ms|s|m|h|d|w)$';

const DURATION = new RegExp(DURATION_PATTERN);

/** Milliseconds of a duration such as '30m', '24h' or '7d'. */
export function parseDuration(value: string, field = 'duration'): number {
  const m = DURATION.exec(value);
  if (!m) {
    throw new InvalidArgument(`${field}: cannot parse duration '${value}' (use e.g. 30m, 24h, 7d)`);
  }
  return Math.round(parseFloat(m[1]) * UNIT_MS[m[2]]);
}
