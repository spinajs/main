import type { ScheduleDefinition } from '../interfaces.js';
import { fireTime } from '../time/occurrences.js';
import { nextOccurrence, ScheduleSpec } from '../time/spec.js';

/** `skippedCapped`: more occurrences were missed than `skipped` says; counting them all would block the tick. */
export type OccurrencePlan =
  | {
      kind: 'run';
      scheduledAt: number;
      trigger: 'schedule' | 'catch-up';
      next: number | null;
      skipped: number;
      skippedCapped?: true;
    }
  | { kind: 'misfire'; scheduledAt: number; next: number | null; skipped: number; skippedCapped?: true };

/**
 * A cron `nextOccurrence` costs about 1 ms, so a plan enumerates at most this many missed occurrences
 * beyond the ones it keeps; past that it finds the latest ones by bisection and caps the count.
 */
export const MISFIRE_SCAN_LIMIT = 100;

interface Missed {
  /** The last `keep` occurrences in `[from, to]`, oldest first. */
  items: number[];
  total: number;
  capped: boolean;
}

const after = (spec: ScheduleSpec, t: number) => nextOccurrence(spec, t) ?? Infinity;

/** Latest occurrence in `[from, to]`, where `from` is an occurrence: bisects on "the next one after p is not past to". */
function lastAtOrBefore(spec: ScheduleSpec, from: number, to: number): number {
  if (after(spec, from) > to) return from;
  let lo = from;
  // occurrences are whole seconds, so the one after `hi` is past `to`
  let hi = Math.max(from + 1000, Math.floor(to / 1000) * 1000);
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (after(spec, mid) <= to) lo = mid;
    else hi = mid;
  }
  return after(spec, lo);
}

/** Occurrences from `from` (an occurrence) up to `to`, without enumerating a long window. */
function missedOccurrences(spec: ScheduleSpec, from: number, to: number, keep: number): Missed {
  if (spec.kind === 'every') {
    const base = Math.floor(from / spec.intervalMs);
    const total = 1 + Math.max(0, Math.floor(to / spec.intervalMs) - base);
    const items: number[] = [];
    for (let i = Math.max(0, total - keep); i < total; i++) items.push(i === 0 ? from : (base + i) * spec.intervalMs);
    return { items, total, capped: false };
  }

  const items: number[] = [];
  let total = 0;
  let t = from;
  while (t <= to && total < keep + MISFIRE_SCAN_LIMIT) {
    total++;
    items.push(t);
    if (items.length > keep) items.shift();
    t = after(spec, t);
  }
  if (t > to) return { items, total, capped: false };

  const last = [lastAtOrBefore(spec, from, to)];
  while (last.length < keep) last.unshift(lastAtOrBefore(spec, from, last[0] - 1));
  return { items: last, total, capped: true };
}

/** Decides what to do with the due occurrence `expected` when the loop sees it at `now`. */
export function planOccurrence(def: ScheduleDefinition, expected: number, now: number): OccurrencePlan {
  const next = (t: number) => nextOccurrence(def.spec, t);
  if (now - fireTime(def, expected) <= def.misfireThresholdMs) {
    return { kind: 'run', scheduledAt: expected, trigger: 'schedule', next: next(expected), skipped: 0 };
  }

  const keep = def.misfire.kind === 'catch-up' ? def.misfire.max : 1;
  const m = missedOccurrences(def.spec, expected, now, keep);
  const capped = m.capped ? { skippedCapped: true as const } : {};
  const latest = m.items[m.items.length - 1];

  switch (def.misfire.kind) {
    case 'skip':
      return { kind: 'misfire', scheduledAt: expected, next: next(latest), skipped: m.total, ...capped };
    case 'run-once':
      return {
        kind: 'run',
        scheduledAt: latest,
        trigger: 'catch-up',
        next: next(latest),
        skipped: m.total - 1,
        ...capped,
      };
    case 'catch-up': {
      const first = m.items[0];
      return {
        kind: 'run',
        scheduledAt: first,
        trigger: 'catch-up',
        // the following missed occurrence is already due, so the loop runs them one by one
        next: m.items.length > 1 ? m.items[1] : next(first),
        skipped: m.total - m.items.length,
        ...capped,
      };
    }
  }
}
