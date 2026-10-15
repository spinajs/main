import { createHash } from 'crypto';
import { nextOccurrence, ScheduleSpec } from './spec.js';

// Deterministic so every replica derives the same fire time for an occurrence.
export function jitterFor(name: string, nominalMs: number, jitterMs: number): number {
  const seconds = Math.floor(jitterMs / 1000);
  if (seconds <= 0) return 0;
  const h = createHash('sha1').update(`${name}:${nominalMs}`).digest().readUInt32BE(0);
  return (h % (seconds + 1)) * 1000;
}

export function fireTime(def: { name: string; jitterMs: number }, nominalMs: number): number {
  return nominalMs + jitterFor(def.name, nominalMs, def.jitterMs);
}

export function scanMissed(
  spec: ScheduleSpec,
  fromInclusive: number,
  toInclusive: number,
  keepLast = 1,
  cap = 100_000,
): { items: number[]; total: number; last: number } {
  const items: number[] = [];
  let total = 0;
  let t: number | null = fromInclusive;
  while (t !== null && t <= toInclusive && total < cap) {
    total++;
    items.push(t);
    if (items.length > keepLast) items.shift();
    t = nextOccurrence(spec, t);
  }
  return { items, total, last: items.length ? items[items.length - 1] : fromInclusive };
}
