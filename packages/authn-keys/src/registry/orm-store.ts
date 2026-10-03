import { Injectable } from '@spinajs/di';
import type { IdentityRef, KeyOwner, KeyRecord } from '@spinajs/authn/contracts';
import { AuthnKey } from '../models/AuthnKey.js';
import { fromUtcColumn, toUtcColumn } from '../models/utc.js';
import { decodeCeiling, decodePrincipalRef, encodeCeiling, encodePrincipalRef, KeyStore, sameOwner } from './store.js';

function toRecord(row: AuthnKey): KeyRecord {
  const createdBy = row.created_by ? decodePrincipalRef(row.created_by) : undefined;
  const expiresAt = fromUtcColumn(row.expires_at);
  const revokedAt = fromUtcColumn(row.revoked_at);
  const lastUsedAt = fromUtcColumn(row.last_used_at);
  return Object.freeze({
    kid: row.kid,
    owner: Object.freeze({ type: row.owner_type, id: row.owner_id }) as KeyOwner,
    alg: row.alg,
    jwk: Object.freeze(JSON.parse(row.jwk)),
    thumbprint: row.thumbprint,
    ...(row.name ? { name: row.name } : {}),
    ...(row.scope ? { scope: decodeCeiling(row.scope) } : {}),
    createdAt: fromUtcColumn(row.created_at)!,
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
      created_at: toUtcColumn(key.createdAt),
      ...(key.expiresAt ? { expires_at: toUtcColumn(key.expiresAt) } : {}),
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
    // A case-insensitive collation (MySQL's default) would also match another case of the kid.
    const row = (await AuthnKey.where('kid', kid)).find((r) => r.kid === kid);
    return row ? toRecord(row) : null;
  }

  async listByOwner(owner: IdentityRef): Promise<readonly KeyRecord[]> {
    const rows = await AuthnKey.where({ owner_type: owner.type, owner_id: owner.id });
    return rows.map(toRecord);
  }

  async revoke(owner: IdentityRef, kid: string, at: Date): Promise<'revoked' | 'already' | 'none'> {
    const row = await this.get(kid);
    if (!row || !sameOwner(row.owner, owner)) {
      return 'none';
    }
    if (row.revokedAt) {
      return 'already';
    }
    const r = (await AuthnKey.update({ revoked_at: toUtcColumn(at) })
      .where('kid', kid)
      .whereNull('revoked_at')) as unknown as { RowsAffected?: number };
    return (r?.RowsAffected ?? 1) > 0 ? 'revoked' : 'already';
  }

  async touch(kid: string, at: Date): Promise<void> {
    await AuthnKey.update({ last_used_at: toUtcColumn(at) }).where('kid', kid);
  }
}
