import { randomBytes, randomUUID } from 'node:crypto';

import { SecretStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Autoinject, Injectable, PerChildInstance } from '@spinajs/di';
import { everyNthCall, Orm, OrmDriver, purgeBatch, rowsAffected } from '@spinajs/orm';
import type { IWhereBuilder } from '@spinajs/orm';
import { _check_arg, _finite, _gt, _is_number, _is_string, _max_length, _non_empty, _try_check_arg } from '@spinajs/util';

import { identityKey } from '../identity.js';
import { StoreConnection } from '../support/connection.js';
import { checkedMs, checkedText, columnText, selectTime, sha256hex, sqlTime, textMs } from '../support/sql.js';

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
@PerChildInstance()
@Injectable(SecretStore)
export class DbSecretStore extends SecretStore {
  @Autoinject(Orm)
  protected Orm: Orm;

  private readonly connection: StoreConnection;
  private readonly purgeDue = everyNthCall(PURGE_EVERY);

  /** DI passes nothing and injects the Orm of the resolving container; tests pass a driver. */
  constructor(driver?: OrmDriver) {
    super();
    this.connection = new StoreConnection('DbSecretStore', driver, () => this.Orm);
  }

  public async issue(identity: IdentityRef, purpose: string, ttlSeconds: number): Promise<string> {
    const key = identityKey(identity);
    checkedText(purpose, PURPOSE_MAX, 'DbSecretStore: purpose');
    _check_arg(_is_number(_finite(), _gt(0)))(ttlSeconds, 'ttlSeconds');
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
    if (!_try_check_arg(_is_string(_non_empty(), _max_length(RAW_MAX)))(raw, 'raw')[0]) return false;
    const nowMs = checkedMs(new Date(), 'DbSecretStore.redeem: the clock');
    const { driver } = await this.connection.get();
    await this.purgeNowAndThen(nowMs);

    const q = driver.select().from(TABLE).select('id').select('identity').select('purpose');
    const rows = (await selectTime(driver, q, 'expires_at', 'expires_text').where('secret_hash', sha256hex(raw)).where('identity', key).where('purpose', purpose).whereNull('used_at')) as Record<string, unknown>[];
    // MySQL and MSSQL default collations ignore case: the binding to identity and purpose is checked exactly here.
    const row = rows.find((r) => r.identity === key && r.purpose === purpose);
    if (!row || !this.liveInNode(columnText(row, 'expires_text'), nowMs)) return false;

    const now = sqlTime(nowMs);
    const claimed = await driver.update().in(TABLE).update({ used_at: now }).where('id', String(row.id)).whereNull('used_at').where('expires_at', '>', now);
    return rowsAffected(claimed) === 1;
  }

  /** Deletes up to one batch of spent and expired rows; returns how many went. */
  public async purge(now: Date = new Date()): Promise<number> {
    const t = sqlTime(checkedMs(now, 'DbSecretStore.purge: now'));
    const { driver } = await this.connection.get();
    const done = function (this: IWhereBuilder<unknown>) {
      this.whereNotNull('used_at');
      this.orWhere('expires_at', '<=', t);
    };
    return purgeBatch(driver, { table: TABLE, key: 'id', where: done, limit: PURGE_BATCH });
  }

  /** @internal An early exit only: the claim's SQL guard decides. */
  protected liveInNode(expiresText: string | null, nowMs: number): boolean {
    const ms = expiresText === null ? NaN : textMs(expiresText);
    return !Number.isFinite(ms) || ms > nowMs;
  }

  private async purgeNowAndThen(nowMs: number): Promise<void> {
    if (this.purgeDue()) {
      await this.purge(new Date(nowMs));
    }
  }
}
