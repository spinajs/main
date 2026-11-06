import { randomFillSync } from 'node:crypto';

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
// One random fill serves 512 ids; a decision id is minted on every tapped check.
const POOL = new Uint8Array(10 * 512);
let offset = POOL.length;

/** A UUIDv7: 48 bits of Unix milliseconds, then version, variant and 74 random bits, so ids sort by time. */
export function newDecisionId(now: number = Date.now()): string {
  if (offset === POOL.length) {
    randomFillSync(POOL);
    offset = 0;
  }
  const r = POOL.subarray(offset, offset + 10);
  offset += 10;
  const t = now.toString(16).padStart(12, '0').slice(-12);
  const h = (i: number) => HEX[r[i]];
  return `${t.slice(0, 8)}-${t.slice(8)}-7${HEX[r[0] & 0x0f][1]}${h(1)}-${HEX[(r[2] & 0x3f) | 0x80]}${h(3)}-${h(4)}${h(5)}${h(6)}${h(7)}${h(8)}${h(9)}`;
}
