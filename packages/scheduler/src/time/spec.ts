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
  const given = (['cron', 'every', 'at', 'manual'] as const).filter((k) => input[k] !== undefined && input[k] !== false);
  if (given.length === 0) {
    throw new InvalidArgument(`schedule '${name}': set one of cron, every, at or manual`);
  }
  if (given.length > 1) {
    throw new InvalidArgument(`schedule '${name}': only one of cron, every, at or manual may be set (got ${given.join(', ')})`);
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
    const at = DateTime.fromISO(input.at, { zone: timezone });
    if (!at.isValid) {
      throw new InvalidArgument(`schedule '${name}': at must be an ISO-8601 instant (got '${input.at}')`);
    }
    return { kind: 'at', expression: input.at, at: Math.floor(at.toMillis() / 1000) * 1000, timezone };
  }

  return { kind: 'manual', expression: 'manual', timezone };
}

const MAX_DST_SHIFT_MS = 3 * 3_600_000;

/** Local wall-clock time of `t` in `zone`, carried as a UTC DateTime so no DST applies to it. */
function toWall(t: number, zone: string): DateTime {
  const d = DateTime.fromMillis(t, { zone });
  return DateTime.fromObject({ year: d.year, month: d.month, day: d.day, hour: d.hour, minute: d.minute, second: d.second }, { zone: 'UTC' });
}

/** Luxon resolves a repeated wall time to its first instant and a skipped one forward by the DST shift. */
function fromWall(wall: DateTime, zone: string): number {
  return DateTime.fromObject({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second }, { zone }).toMillis();
}

const isRepeatedWallTime = (t: number, zone: string) => fromWall(toWall(t, zone), zone) !== t;

/** First whole second at or after `t` that is not in the second pass of a repeated hour. */
function endOfRepeatedHour(t: number, zone: string): number {
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

/**
 * Cron fields are matched against local wall-clock time with a UTC `CronTime`, then mapped to an instant
 * here: cron 4's own DST handling returns past instants inside a repeated hour and non-matching times on
 * half-hour shifts. A repeated wall time fires once (first pass), a skipped one fires shifted forward.
 */
function nextCron(spec: Extract<ScheduleSpec, { kind: 'cron' }>, afterMs: number): number | null {
  const zone = spec.timezone;
  const cron = new CronTime(spec.expression, 'UTC');
  let wall = toWall(afterMs, zone);
  for (let guard = 0; guard < 8; guard++) {
    const next = cron.getNextDateFrom(wall, 'UTC');
    const t = Math.floor(fromWall(next, zone) / 1000) * 1000;
    if (t > afterMs) return t;
    // `next` already fired in the first pass of a repeated hour.
    const lastRepeated = toWall(endOfRepeatedHour(afterMs, zone) - 1000, zone);
    wall = lastRepeated.toMillis() > next.toMillis() ? lastRepeated : next;
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
