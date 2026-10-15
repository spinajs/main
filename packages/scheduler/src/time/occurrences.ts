import { createHash } from 'crypto';

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
