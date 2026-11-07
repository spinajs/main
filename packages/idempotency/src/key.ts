import { createHash } from 'node:crypto';
import type { IdempotencyScope } from './interfaces.js';

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** sha256 of a JSON array, not of a concatenation: 'ab' + 'c' and 'a' + 'bc' must stay two keys. */
export function idempotencyKey(scope: IdempotencyScope, key: string): string {
  return sha256(JSON.stringify([scope.namespace, scope.principal ?? null, key]));
}

export function fingerprintOf(data: string | Uint8Array): string {
  return sha256(data);
}
