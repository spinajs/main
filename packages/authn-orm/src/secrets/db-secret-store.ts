import { randomBytes, randomUUID } from 'node:crypto';

import { SecretStore } from '@spinajs/authn/contracts';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { Injectable, Singleton } from '@spinajs/di';
import { ormReady } from '@spinajs/orm';
import type { WhereBuilder } from '@spinajs/orm';
import { _check_arg, _finite, _gt, _is_number, _is_string, _max_length, _non_empty, _try_check_arg } from '@spinajs/util';
import type { DateTime } from 'luxon';

import { identityKey } from '../identity.js';
import { AuthnSecret } from '../models/AuthnSecret.js';
import { checkedMs, checkedText, instant, sha256hex } from '../support/sql.js';
import { columnValues } from '../support/values.js';

const PURPOSE_MAX = 32;
const PURGE_EVERY = 64;
const PURGE_BATCH = 500;
/** Far above any secret this store issues; longer input is refused before hashing. */
const RAW_MAX = 1024;

/**
 * `authn_secret`: single-use secrets stored as the hex SHA-256 of the raw value only (SR-09). The raw secret is
 * 32 random bytes as base64url (43 chars). Times are taken in Node at call time (F7); the claim of `redeem`
 * decides expiry and single use in SQL against that time (D10).
 *
 * Two parallel `issue` calls for one identity and purpose may both leave a live row: each deletes, then inserts.
 */
@Singleton()
@Injectable(SecretStore)
export class DbSecretStore extends SecretStore {
  private calls = 0;

  public async issue(identity: IdentityRef, purpose: string, ttlSeconds: number): Promise<string> {
    const key = identityKey(identity);
    checkedText(purpose, PURPOSE_MAX, 'DbSecretStore: purpose');
    _check_arg(_is_number(_finite(), _gt(0)))(ttlSeconds, 'ttlSeconds');
    const nowMs = checkedMs(new Date(), 'DbSecretStore.issue: the clock');
    await ormReady();
    await this.purgeNowAndThen(nowMs);

    const raw = randomBytes(32).toString('base64url');
    await AuthnSecret.destroy().where('identity', key).where('purpose', purpose);
    await AuthnSecret.insert(columnValues<AuthnSecret>({ id: randomUUID(), identity: key, purpose, secret_hash: sha256hex(raw), expires_at: instant(nowMs + ttlSeconds * 1000), used_at: null, created_at: instant(nowMs) }));
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
    await ormReady();
    await this.purgeNowAndThen(nowMs);

    const rows = await AuthnSecret.query().columns(['id', 'identity', 'purpose', 'expires_at']).where('secret_hash', sha256hex(raw)).where('identity', key).where('purpose', purpose).whereNull('used_at');
    // MySQL and MSSQL default collations ignore case: the binding to identity and purpose is checked exactly here.
    const row = rows.find((r) => r.identity === key && r.purpose === purpose);
    if (!row || !this.liveInNode(row.expires_at, nowMs)) return false;

    const now = instant(nowMs);
    const { RowsAffected } = await AuthnSecret.update({ used_at: now }).where('id', row.id).whereNull('used_at').where('expires_at', '>', now);
    return RowsAffected === 1;
  }

  /** Deletes up to one batch of spent and expired rows; returns how many went. */
  public async purge(now: Date = new Date()): Promise<number> {
    const ms = checkedMs(now, 'DbSecretStore.purge: now');
    await ormReady();
    const t = instant(ms);
    const done = function (this: WhereBuilder<unknown>) {
      this.whereNotNull('used_at');
      this.orWhere('expires_at', '<=', t);
    };
    // MSSQL pages with OFFSET … FETCH, which needs an ORDER BY.
    const ids = (await AuthnSecret.query().columns(['id']).where(done).orderBy('id').take(PURGE_BATCH)).map((r) => r.id);
    if (ids.length === 0) return 0;
    return (await AuthnSecret.destroy().whereIn('id', ids).where(done)).RowsAffected;
  }

  /** @internal An early exit only: the claim's SQL guard decides. */
  protected liveInNode(expiresAt: DateTime | null | undefined, nowMs: number): boolean {
    const ms = expiresAt ? expiresAt.toMillis() : NaN;
    return !Number.isFinite(ms) || ms > nowMs;
  }

  private async purgeNowAndThen(nowMs: number): Promise<void> {
    if (++this.calls % PURGE_EVERY === 0) {
      await this.purge(new Date(nowMs));
    }
  }
}
