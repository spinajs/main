import { InvalidArgument } from '@spinajs/exceptions';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';

import { NonceStore } from '../contracts/nonce.js';

const KEY_MAX = 160;
const PURGE_EVERY = 64;
// The range DbNonceStore can store, so both stores refuse the same dates.
const MIN_MS = Date.UTC(1000, 0, 1);
const MAX_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

function checkedMs(value: unknown, label: string): number {
  const ms = value instanceof Date ? value.getTime() : NaN;
  if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
    throw new InvalidArgument(`${label} must be a valid Date`);
  }
  return ms;
}

/** One process only. */
export class MemoryNonceStore extends NonceStore {
  private readonly live = new Map<string, number>();
  private claims = 0;

  public async claim(key: string, expiresAt: Date, now: Date): Promise<boolean> {
    const length = [..._check_arg(_is_string(_non_empty()))(key, 'MemoryNonceStore.claim: key')].length;
    if (length > KEY_MAX) {
      throw new InvalidArgument(`MemoryNonceStore.claim: key is ${length} characters long, at most ${KEY_MAX} are allowed`);
    }
    const expiresMs = checkedMs(expiresAt, 'MemoryNonceStore.claim: expiresAt');
    const nowMs = checkedMs(now, 'MemoryNonceStore.claim: now');
    if (++this.claims % PURGE_EVERY === 0) {
      for (const [k, until] of this.live) {
        if (until <= nowMs) this.live.delete(k);
      }
    }
    const until = this.live.get(key);
    if (until !== undefined && until > nowMs) return false;
    this.live.set(key, expiresMs);
    return true;
  }
}
