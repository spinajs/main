import { CronTime } from 'cron';
import { DateTime, IANAZone } from 'luxon';
import { InvalidArgument } from '@spinajs/exceptions';
import { parseDuration } from './duration.js';
import type { ScheduleSpecInfo } from '../contract.js';

export type ScheduleSpec =
  | { kind: 'cron'; expression: string; timezone: string }
  | { kind: 'every'; expression: string; intervalMs: number; timezone: string }
  | { kind: 'at'; expression: string; at: number; timezone: string }
  | { kind: 'manual'; expression: 'manual'; timezone: string };

export interface SpecInput {
  cron?: string;
  every?: number | string;
  at?: string;
  manual?: boolean;
  timezone?: string;
}

export function parseSpec(input: SpecInput, name: string): ScheduleSpec {
  const given = (['cron', 'every', 'at', 'manual'] as const).filter(
    (k) => input[k] !== undefined && input[k] !== false,
  );
  if (given.length === 0) {
    throw new InvalidArgument(`schedule '${name}': set one of cron, every, at or manual`);
  }
  if (given.length > 1) {
    throw new InvalidArgument(
      `schedule '${name}': only one of cron, every, at or manual may be set (got ${given.join(', ')})`,
    );
  }

  const timezone = input.timezone ?? 'UTC';
  if (!IANAZone.isValidZone(timezone)) {
    throw new InvalidArgument(`schedule '${name}': unknown time zone '${timezone}'`);
  }

  if (input.cron !== undefined) {
    try {
      new CronTime(input.cron, timezone);
    } catch (err) {
      throw new InvalidArgument(`schedule '${name}': invalid cron '${input.cron}': ${(err as Error).message}`);
    }
    return { kind: 'cron', expression: input.cron, timezone };
  }

  if (input.every !== undefined) {
    const intervalMs = parseDuration(input.every, `schedule '${name}' every`);
    if (intervalMs < 1000 || intervalMs % 1000 !== 0) {
      throw new InvalidArgument(`schedule '${name}': every must be whole seconds, at least 1s (got ${input.every})`);
    }
    return { kind: 'every', expression: String(input.every), intervalMs, timezone };
  }

  if (input.at !== undefined) {
    const asUtc = DateTime.fromISO(input.at, { zone: 'UTC' });
    if (!asUtc.isValid) {
      throw new InvalidArgument(`schedule '${name}': at must be an ISO-8601 instant (got '${input.at}')`);
    }
    // Same instant under another default zone = the string carries its own offset.
    const hasOffset = DateTime.fromISO(input.at, { zone: 'UTC+5' }).toMillis() === asUtc.toMillis();
    const at = hasOffset ? asUtc.toMillis() : fromWall(asUtc.toMillis(), IANAZone.create(timezone));
    return { kind: 'at', expression: input.at, at: Math.floor(at / 1000) * 1000, timezone };
  }

  return { kind: 'manual', expression: 'manual', timezone };
}

const MAX_DST_SHIFT_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

/** Local wall-clock time of `t` in `zone` as epoch ms of the same fields in UTC, whole seconds. */
function toWall(t: number, zone: IANAZone): number {
  return Math.floor((t + zone.offset(t) * 60_000) / 1000) * 1000;
}

/**
 * Instant of a local wall-clock time: a repeated one resolves to its first pass, a skipped one moves forward by
 * the DST shift. Resolved here because luxon's `fromObject` picks the pass from the offset at `Settings.now()`.
 */
function fromWall(wall: number, zone: IANAZone): number {
  const before = zone.offset(wall - DAY_MS);
  const after = zone.offset(wall + DAY_MS);
  const valid = [wall - before * 60_000, wall - after * 60_000].filter((t) => zone.offset(t) * 60_000 === wall - t);
  return valid.length ? Math.min(...valid) : wall - Math.min(before, after) * 60_000;
}

const isRepeatedWallTime = (t: number, zone: IANAZone) => fromWall(toWall(t, zone), zone) !== t;

/** First whole second at or after `t` that is not in the second pass of a repeated hour. */
function endOfRepeatedHour(t: number, zone: IANAZone): number {
  let lo = Math.floor(t / 1000) * 1000;
  if (!isRepeatedWallTime(lo, zone)) return lo;
  let hi = lo + MAX_DST_SHIFT_MS;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (isRepeatedWallTime(mid, zone)) lo = mid;
    else hi = mid;
  }
  return hi;
}

const CRON_CACHE_SIZE = 256;
const cronCache = new Map<string, CronTime>();

function wallCron(expression: string): CronTime {
  let cron = cronCache.get(expression);
  if (!cron) {
    if (cronCache.size >= CRON_CACHE_SIZE) cronCache.delete(cronCache.keys().next().value as string);
    cron = new CronTime(expression, 'UTC');
    cronCache.set(expression, cron);
  }
  return cron;
}

/**
 * Cron fields are matched against local wall-clock time with a UTC `CronTime`, then mapped to an instant
 * here: cron 4's own DST handling returns past instants inside a repeated hour and non-matching times on
 * half-hour shifts. A repeated wall time fires once (first pass), a skipped one fires shifted forward.
 * Known limit: only the first match inside a spring gap fires; later matches in the same gap are dropped
 * (`20,40 2 * * *` on a 02:00-02:30 gap fires once, at 02:50).
 */
function nextCron(spec: Extract<ScheduleSpec, { kind: 'cron' }>, afterMs: number): number | null {
  const zone = IANAZone.create(spec.timezone);
  const cron = wallCron(spec.expression);
  let wall = toWall(afterMs, zone);
  for (let guard = 0; guard < 8; guard++) {
    const next = cron.getNextDateFrom(DateTime.fromMillis(wall, { zone: 'UTC' }), 'UTC').toMillis();
    const t = Math.floor(fromWall(next, zone) / 1000) * 1000;
    if (t > afterMs) return t;
    // `next` already fired in the first pass of a repeated hour.
    wall = Math.max(next, toWall(endOfRepeatedHour(afterMs, zone) - 1000, zone));
  }
  return null;
}

export function nextOccurrence(spec: ScheduleSpec, afterMs: number): number | null {
  switch (spec.kind) {
    case 'cron':
      return nextCron(spec, afterMs);
    case 'every':
      return (Math.floor(afterMs / spec.intervalMs) + 1) * spec.intervalMs;
    case 'at':
      return spec.at > afterMs ? spec.at : null;
    case 'manual':
      return null;
  }
}

export function describeSpec(spec: ScheduleSpec): ScheduleSpecInfo {
  return { kind: spec.kind, expression: spec.expression, timezone: spec.timezone };
}
