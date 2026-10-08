import { Injectable, Singleton } from '@spinajs/di';
import { OrmDriver } from '@spinajs/orm';

import { StoreConnection } from '../support/connection.js';
import type { StoreOptions } from '../support/connection.js';
import { checkedMs, checkedText, isDuplicate, rowsAffected, sqlTime } from '../support/sql.js';

const TABLE = 'authn_nonce';
const KEY_MAX = 160;
const PURGE_EVERY = 64;
const PURGE_BATCH = 500;
/** A miss after a duplicate means a purge removed the row in between; a few retries cover that. */
const MAX_TRIES = 8;

function checkClaim(key: string, expiresAt: Date, now: Date, owner: string): { expiresMs: number; nowMs: number } {
  checkedText(key, KEY_MAX, `${owner}.claim: key`);
  return { expiresMs: checkedMs(expiresAt, `${owner}.claim: expiresAt`), nowMs: checkedMs(now, `${owner}.claim: now`) };
}

/**
 * Single-use values (assertion jti, HTTP signature nonces, OIDC state) until they expire. Same semantics as
 * authn-keys' `KeyNonceStore`, so it can delegate here.
 */
export abstract class NonceStore {
  /** True exactly once while `key` is live: the first claim keeps it until `expiresAt`; an expired key may be claimed again. Keys over 160 chars throw.
   * `expiresAt` at or before `now` is never live, so such a claim is always true: callers refuse expired tokens first.
   */
  abstract claim(key: string, expiresAt: Date, now: Date): Promise<boolean>;
}

/** One process only. */
export class MemoryNonceStore extends NonceStore {
  private readonly live = new Map<string, number>();
  private claims = 0;

  public async claim(key: string, expiresAt: Date, now: Date): Promise<boolean> {
    const { expiresMs, nowMs } = checkClaim(key, expiresAt, now, 'MemoryNonceStore');
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

/** `authn_nonce`: the primary key makes a claim atomic across processes; an expired row is taken over with a conditional update. */
@Singleton()
@Injectable(NonceStore)
export class DbNonceStore extends NonceStore {
  private readonly connection: StoreConnection;
  private claims = 0;

  /** DI passes nothing: the Orm's `'default'` connection is resolved on first use. */
  constructor(driver?: OrmDriver, options: StoreOptions = {}) {
    super();
    this.connection = new StoreConnection('DbNonceStore', driver, options.container);
  }

  public async claim(key: string, expiresAt: Date, now: Date): Promise<boolean> {
    const { expiresMs, nowMs } = checkClaim(key, expiresAt, now, 'DbNonceStore');
    const { driver } = await this.connection.get();
    if (++this.claims % PURGE_EVERY === 0) {
      await this.purge(now);
    }

    const t = sqlTime(nowMs);
    const expires = sqlTime(expiresMs);
    for (let i = 0; i < MAX_TRIES; i++) {
      try {
        await driver.insert().into(TABLE).values({ k: key, expires_at: expires });
        return true;
      } catch (err) {
        if (!isDuplicate(err)) throw err;
      }
      if (rowsAffected(await driver.update().in(TABLE).update({ expires_at: expires }).where('k', key).where('expires_at', '<=', t)) === 1) {
        return true;
      }
      const live = (await driver.select().from(TABLE).select('k').where('k', key).where('expires_at', '>', t)) as unknown[];
      if (live.length > 0) return false;
    }
    return false;
  }

  /** Deletes up to one batch of expired keys; returns how many went. */
  public async purge(now: Date = new Date()): Promise<number> {
    const t = sqlTime(checkedMs(now, 'DbNonceStore.purge: now'));
    const { driver } = await this.connection.get();
    // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
    const keys = ((await driver.select().from(TABLE).select('k').where('expires_at', '<=', t).orderBy('k').take(PURGE_BATCH)) as { k: string }[]).map((r) => r.k);
    if (keys.length === 0) return 0;
    return rowsAffected(await driver.del().from(TABLE).whereIn('k', keys).where('expires_at', '<=', t));
  }
}
