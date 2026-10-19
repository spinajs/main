import { createHash } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { DateTime } from 'luxon';
import { AuthnNonce } from '../models/AuthnNonce.js';

/** Single-use values (assertion jti, HTTP signature nonces) until they expire. */
export abstract class KeyNonceStore {
  /** True exactly once while `key` is live: the first claim keeps it until `expiresAt`; an expired key may be claimed again. */
  abstract claim(key: string, expiresAt: Date, now: Date): Promise<boolean>;
}

/** A fixed-length store key for a value a client chose, scoped to the key that signed it. */
export const nonceKey = (scope: 'jti' | 'sig', kid: string, value: string): string => `${scope}:${createHash('sha256').update(`${kid}\n${value}`, 'utf8').digest('base64url')}`;

const SWEEP_EVERY = 256;

export class MemoryKeyNonceStore extends KeyNonceStore {
  private readonly live = new Map<string, number>();
  private claims = 0;

  async claim(key: string, expiresAt: Date, now: Date): Promise<boolean> {
    const nowMs = now.getTime();
    this.claims += 1;
    if (this.claims % SWEEP_EVERY === 0) {
      for (const [k, until] of this.live) {
        if (until <= nowMs) {
          this.live.delete(k);
        }
      }
    }
    const until = this.live.get(key);
    if (until !== undefined && until > nowMs) {
      return false;
    }
    this.live.set(key, expiresAt.getTime());
    return true;
  }
}

const PURGE_EVERY = 64;
const PURGE_BATCH = 500;

/** authn_nonce through the ORM: the primary key makes a claim atomic across processes. */
@Injectable(KeyNonceStore)
export class DbKeyNonceStore extends KeyNonceStore {
  private claims = 0;

  async claim(key: string, expiresAt: Date, now: Date): Promise<boolean> {
    const nowDt = DateTime.fromJSDate(now);
    this.claims += 1;
    if (this.claims % PURGE_EVERY === 0) {
      await this.purge(nowDt);
    }
    try {
      await new AuthnNonce({ k: key, expires_at: DateTime.fromJSDate(expiresAt) }).insert();
      return true;
    } catch (e) {
      // Taken: only an expired row may be taken over, and the conditional update lets one claimant win.
      const r = (await AuthnNonce.update({ expires_at: DateTime.fromJSDate(expiresAt) })
        .where('k', key)
        .where('expires_at', '<=', nowDt)) as unknown as { RowsAffected?: number };
      if ((r?.RowsAffected ?? 0) === 1) {
        return true;
      }
      if ((await AuthnNonce.where('k', key)).length === 0) {
        throw e;
      }
      return false;
    }
  }

  private async purge(now: DateTime): Promise<void> {
    const expired: AuthnNonce[] = await AuthnNonce.where('expires_at', '<=', now).take(PURGE_BATCH);
    if (expired.length > 0) {
      await AuthnNonce.destroy(expired.map((r) => r.k)).where('expires_at', '<=', now);
    }
  }
}
