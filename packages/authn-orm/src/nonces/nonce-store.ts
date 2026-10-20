import { NonceStore } from '@spinajs/authn/contracts';
import { Injectable, PerChildInstance } from '@spinajs/di';
import { UniqueViolation, ormReady } from '@spinajs/orm';

import { AuthnNonce } from '../models/AuthnNonce.js';
import { checkedMs, checkedText, instant } from '../support/sql.js';

export { NonceStore } from '@spinajs/authn/contracts';
export { MemoryNonceStore } from '@spinajs/authn/nonces';

const KEY_MAX = 160;
const PURGE_EVERY = 64;
const PURGE_BATCH = 500;
/** A miss after a duplicate means a purge removed the row in between; a few retries cover that. */
const MAX_TRIES = 8;

function checkClaim(key: string, expiresAt: Date, now: Date, owner: string): { expiresMs: number; nowMs: number } {
  checkedText(key, KEY_MAX, `${owner}.claim: key`);
  return { expiresMs: checkedMs(expiresAt, `${owner}.claim: expiresAt`), nowMs: checkedMs(now, `${owner}.claim: now`) };
}

/** `authn_nonce`: the primary key makes a claim atomic across processes; an expired row is taken over with a conditional update. */
@PerChildInstance()
@Injectable(NonceStore)
export class DbNonceStore extends NonceStore {
  private claims = 0;

  public async claim(key: string, expiresAt: Date, now: Date): Promise<boolean> {
    const { expiresMs, nowMs } = checkClaim(key, expiresAt, now, 'DbNonceStore');
    await ormReady();
    if (++this.claims % PURGE_EVERY === 0) {
      await this.purge(now);
    }

    const t = instant(nowMs);
    const expires = instant(expiresMs);
    for (let i = 0; i < MAX_TRIES; i++) {
      try {
        await AuthnNonce.insert({ k: key, expires_at: expires });
        return true;
      } catch (err) {
        if (!(err instanceof UniqueViolation)) throw err;
      }
      if ((await AuthnNonce.update({ expires_at: expires }).where('k', key).where('expires_at', '<=', t)).RowsAffected === 1) {
        return true;
      }
      const live = await AuthnNonce.query().columns(['k']).where('k', key).where('expires_at', '>', t);
      if (live.length > 0) return false;
    }
    return false;
  }

  /** Deletes up to one batch of expired keys; returns how many went. */
  public async purge(now: Date = new Date()): Promise<number> {
    const ms = checkedMs(now, 'DbNonceStore.purge: now');
    await ormReady();
    const t = instant(ms);
    // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
    const keys = (await AuthnNonce.query().columns(['k']).where('expires_at', '<=', t).orderBy('k').take(PURGE_BATCH)).map((r) => r.k);
    if (keys.length === 0) return 0;
    return (await AuthnNonce.destroy().whereIn('k', keys).where('expires_at', '<=', t)).RowsAffected;
  }
}
