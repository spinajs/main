import { Injectable } from '@spinajs/di';
import { DateTime } from 'luxon';
import type { IdentityRef, KeyOwner, KeyRecord } from '@spinajs/authn/contracts';
import { AuthnKey } from '../models/AuthnKey.js';
import { decodeCeiling, decodePrincipalRef, encodeCeiling, encodePrincipalRef, KeyStore, sameOwner } from './store.js';

const toDate = (v: DateTime | Date | string | null | undefined): Date | undefined => {
  if (v === null || v === undefined) {
    return undefined;
  }
  if (v instanceof Date) {
    return v;
  }
  return typeof v === 'string' ? new Date(v) : v.toJSDate();
};

const fromDate = (d: Date): DateTime => DateTime.fromJSDate(d);

function toRecord(row: AuthnKey): KeyRecord {
  const createdBy = row.created_by ? decodePrincipalRef(row.created_by) : undefined;
  const expiresAt = toDate(row.expires_at);
  const revokedAt = toDate(row.revoked_at);
  const lastUsedAt = toDate(row.last_used_at);
  return Object.freeze({
    kid: row.kid,
    owner: Object.freeze({ type: row.owner_type, id: row.owner_id }) as KeyOwner,
    alg: row.alg,
    jwk: Object.freeze(JSON.parse(row.jwk)),
    thumbprint: row.thumbprint,
    ...(row.name ? { name: row.name } : {}),
    ...(row.scope ? { scope: decodeCeiling(row.scope) } : {}),
    createdAt: toDate(row.created_at)!,
    ...(createdBy ? { createdBy } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
  }) as KeyRecord;
}

/** authn_key through the ORM (connection 'default', migration AuthnKeys_2026_10_02_00_00_00). */
@Injectable(KeyStore)
export class OrmKeyStore extends KeyStore {
  private async taken(key: KeyRecord): Promise<boolean> {
    const byKid = await AuthnKey.where('kid', key.kid);
    const byThumb = await AuthnKey.where('thumbprint', key.thumbprint);
    return byKid.length > 0 || byThumb.length > 0;
  }

  async insert(key: KeyRecord): Promise<'inserted' | 'duplicate'> {
    if (await this.taken(key)) {
      return 'duplicate';
    }
    const row = new AuthnKey({
      kid: key.kid,
      owner_type: key.owner.type,
      owner_id: key.owner.id,
      alg: key.alg,
      jwk: JSON.stringify(key.jwk),
      thumbprint: key.thumbprint,
      scope: key.scope ? encodeCeiling(key.scope) : null,
      name: key.name ?? null,
      created_by: key.createdBy ? encodePrincipalRef(key.createdBy) : null,
      created_at: fromDate(key.createdAt),
      ...(key.expiresAt ? { expires_at: fromDate(key.expiresAt) } : {}),
    });
    try {
      await row.insert();
    } catch (e) {
      // Drivers report a unique violation differently; a row that now exists means another insert won the race.
      if (await this.taken(key)) {
        return 'duplicate';
      }
      throw e;
    }
    return 'inserted';
  }

  async get(kid: string): Promise<KeyRecord | null> {
    const rows = await AuthnKey.where('kid', kid);
    return rows.length > 0 ? toRecord(rows[0]) : null;
  }

  async listByOwner(owner: IdentityRef): Promise<readonly KeyRecord[]> {
    const rows = await AuthnKey.where({ owner_type: owner.type, owner_id: owner.id });
    return rows.map(toRecord);
  }

  async revoke(owner: IdentityRef, kid: string, at: Date): Promise<boolean> {
    const row = await this.get(kid);
    if (!row || !sameOwner(row.owner, owner)) {
      return false;
    }
    if (!row.revokedAt) {
      await AuthnKey.update({ revoked_at: fromDate(at) })
        .where('kid', kid)
        .whereNull('revoked_at');
    }
    return true;
  }

  async touch(kid: string, at: Date): Promise<void> {
    await AuthnKey.update({ last_used_at: fromDate(at) }).where('kid', kid);
  }
}
