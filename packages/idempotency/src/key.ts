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

const RANDOM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** UUID v4 or v7: drawn at random, so another caller of a shared scope can neither hit it by chance nor guess it. */
export function isRandomKey(key: string): boolean {
  return RANDOM_UUID.test(key);
}
