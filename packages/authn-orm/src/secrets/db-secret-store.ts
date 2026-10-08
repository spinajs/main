import { randomBytes, randomUUID } from 'node:crypto';

import { SecretStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable, Singleton } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { OrmDriver } from '@spinajs/orm';
import type { WhereBuilder } from '@spinajs/orm';

import { identityKey } from '../identity.js';
import { StoreConnection } from '../support/connection.js';
import type { StoreOptions } from '../support/connection.js';
import { checkedMs, checkedText, columnText, rowsAffected, selectTime, sha256hex, sqlTime, textMs } from '../support/sql.js';

const TABLE = 'authn_secret';
const PURPOSE_MAX = 32;
const PURGE_EVERY = 64;
const PURGE_BATCH = 500;
/** Far above any secret this store or 2.x issued; longer input is refused before hashing. */
const RAW_MAX = 1024;

/**
 * `authn_secret`: single-use secrets stored as the hex SHA-256 of the raw value only (SR-09). The raw secret is
 * 32 random bytes as base64url (43 chars). Times are UTC wall-clock text taken in Node at call time (F7); the
 * claim of `redeem` decides expiry and single use in SQL against that time (D10).
 *
 * Two parallel `issue` calls for one identity and purpose may both leave a live row: each deletes, then inserts.
 */
@Singleton()
@Injectable(SecretStore)
export class DbSecretStore extends SecretStore {
  private readonly connection: StoreConnection;
  private calls = 0;

  /** DI passes nothing: the Orm's `'default'` connection is resolved on first use. */
  constructor(driver?: OrmDriver, options: StoreOptions = {}) {
    super();
    this.connection = new StoreConnection('DbSecretStore', driver, options.container);
  }

  public async issue(identity: IdentityRef, purpose: string, ttlSeconds: number): Promise<string> {
    const key = identityKey(identity);
    checkedText(purpose, PURPOSE_MAX, 'DbSecretStore: purpose');
    if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new InvalidArgument('DbSecretStore.issue: ttlSeconds must be a positive number');
    }
    const nowMs = checkedMs(new Date(), 'DbSecretStore.issue: the clock');
    const { driver } = await this.connection.get();
    await this.purgeNowAndThen(nowMs);

    const raw = randomBytes(32).toString('base64url');
    await driver.del().from(TABLE).where('identity', key).where('purpose', purpose);
    await driver
      .insert()
      .into(TABLE)
      .values({ id: randomUUID(), identity: key, purpose, secret_hash: sha256hex(raw), expires_at: sqlTime(nowMs + ttlSeconds * 1000), used_at: null, created_at: sqlTime(nowMs) });
    return raw;
  }

  /**
   * Looks the row up by the hash of `raw`, so no stored value is compared with the input in Node. The lookup
   * also matches identity and purpose; the claim succeeds for exactly one caller.
   */
  public async redeem(identity: IdentityRef, purpose: string, raw: string): Promise<boolean> {
    const key = identityKey(identity);
    checkedText(purpose, PURPOSE_MAX, 'DbSecretStore: purpose');
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return false;
    const nowMs = checkedMs(new Date(), 'DbSecretStore.redeem: the clock');
    const { driver, dialect } = await this.connection.get();
    await this.purgeNowAndThen(nowMs);

    const q = driver.select().from(TABLE).select('id').select('identity').select('purpose');
    const rows = (await selectTime(dialect, q, 'expires_at', 'expires_text').where('secret_hash', sha256hex(raw)).where('identity', key).where('purpose', purpose).whereNull('used_at')) as Record<string, unknown>[];
    // MySQL and MSSQL default collations ignore case: the binding to identity and purpose is checked exactly here.
    const row = rows.find((r) => r.identity === key && r.purpose === purpose);
    if (!row || !this.liveInNode(columnText(dialect, row, 'expires_at', 'expires_text'), nowMs)) return false;

    const now = sqlTime(nowMs);
    const claimed = await driver.update().in(TABLE).update({ used_at: now }).where('id', String(row.id)).whereNull('used_at').where('expires_at', '>', now);
    return rowsAffected(claimed) === 1;
  }

  /** Deletes up to one batch of spent and expired rows; returns how many went. */
  public async purge(now: Date = new Date()): Promise<number> {
    const t = sqlTime(checkedMs(now, 'DbSecretStore.purge: now'));
    const { driver } = await this.connection.get();
    const done = function (this: WhereBuilder<unknown>) {
      this.whereNotNull('used_at');
      this.orWhere('expires_at', '<=', t);
    };
    // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
    const ids = ((await driver.select().from(TABLE).select('id').where(done).orderBy('id').take(PURGE_BATCH)) as { id: string }[]).map((r) => r.id);
    if (ids.length === 0) return 0;
    return rowsAffected(await driver.del().from(TABLE).whereIn('id', ids).where(done));
  }

  /** @internal An early exit only: the claim's SQL guard decides. */
  protected liveInNode(expiresText: string | null, nowMs: number): boolean {
    const ms = expiresText === null ? NaN : textMs(expiresText);
    return !Number.isFinite(ms) || ms > nowMs;
  }

  private async purgeNowAndThen(nowMs: number): Promise<void> {
    if (++this.calls % PURGE_EVERY === 0) {
      await this.purge(new Date(nowMs));
    }
  }
}
