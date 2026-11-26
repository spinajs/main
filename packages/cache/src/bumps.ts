import { randomBytes } from 'node:crypto';
import type { TagBump } from './contracts.js';

// Module level, not a field of a service: two services of one process must never share a stamp.
const PROCESS = randomBytes(4).toString('hex');
let sequence = 0;

/** One bump per distinct tag, each stamped with the time, a counter and an id of this process, so no two bumps share a stamp. */
export function stampBumps(tags: readonly string[]): TagBump[] {
  const at = Date.now().toString(36);
  return [...new Set(tags)].map((tag) => {
    sequence += 1;
    return { tag, version: `${at}.${sequence.toString(36)}.${PROCESS}` };
  });
}
