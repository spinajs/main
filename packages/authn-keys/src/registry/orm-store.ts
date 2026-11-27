import { Autoinject, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Orm, rowsAffected } from '@spinajs/orm';
import type { ISelectQueryBuilder } from '@spinajs/orm';
import type { IdentityRef, KeyOwner, KeyRecord } from '@spinajs/authn/contracts';
import { sameRef } from '@spinajs/authn/contracts';
import { AuthnKey } from '../models/AuthnKey.js';
import { DateTime } from 'luxon';
import { decodeCeiling, decodePrincipalRef, encodeCeiling, encodePrincipalRef, KeyStore } from './store.js';

/** The datetime converter reads a stored value it cannot parse (text, a MySQL zero date, an infinity) as null, as it reads NULL; the flags tell the two apart. */
function withInstantsSet(query: ISelectQueryBuilder<AuthnKey[]>): ISelectQueryBuilder<AuthnKey[]> {
  return query
    .select('*')
    .selectCondition('expires_at_set', function () {
      this.whereNotNull('expires_at');
    })
    .selectCondition('revoked_at_set', function () {
      this.whereNotNull('revoked_at');
    });
}

const unreadable = (value: DateTime | undefined, set: boolean | undefined): boolean => set === true && value == null;

/** An instant the converter could not read becomes an invalid Date, which isUsableKey reads as revoked and as expired. */
const instantOf = (value: DateTime | undefined, set: boolean | undefined): Date | undefined => (unreadable(value, set) ? new Date(NaN) : value?.toJSDate());

function toRecord(row: AuthnKey): KeyRecord {
  const createdBy = row.created_by ? decodePrincipalRef(row.created_by) : undefined;
  const expiresAt = instantOf(row.expires_at, row.expires_at_set);
  const revokedAt = instantOf(row.revoked_at, row.revoked_at_set);
  const lastUsedAt = row.last_used_at?.toJSDate();
  return Object.freeze({
    kid: row.kid,
    owner: Object.freeze({ type: row.owner_type, id: row.owner_id }) as KeyOwner,
    alg: row.alg,
    jwk: Object.freeze(JSON.parse(row.jwk)),
    thumbprint: row.thumbprint,
    ...(row.name ? { name: row.name } : {}),
    ...(row.scope ? { scope: decodeCeiling(row.scope) } : {}),
    createdAt: row.created_at.toJSDate(),
    ...(createdBy ? { createdBy } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
  }) as KeyRecord;
}

/** authn_key through the ORM (connection 'default', migration AuthnKeys_2026_10_02_00_00_00). */
@Injectable(KeyStore)
export class OrmKeyStore extends KeyStore {
  /** The cli resolves only the command it runs, so without this the models are unbound and every query throws. */
  @Autoinject(Orm)
  protected Orm: Orm;

  @Logger('authn-keys')
  protected Log: Log;

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
      created_at: DateTime.fromJSDate(key.createdAt),
      ...(key.expiresAt ? { expires_at: DateTime.fromJSDate(key.expiresAt) } : {}),
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
    const row = (await withInstantsSet(AuthnKey.query().where('kid', kid))).find((r) => r.kid === kid);
    return row ? this.recordOf(row) : null;
  }

  async listByOwner(owner: IdentityRef): Promise<readonly KeyRecord[]> {
    const rows = await withInstantsSet(AuthnKey.query().where({ owner_type: owner.type, owner_id: owner.id }));
    return rows.map((r) => this.recordOf(r));
  }

  private recordOf(row: AuthnKey): KeyRecord {
    const columns = [unreadable(row.expires_at, row.expires_at_set) ? 'expires_at' : '', unreadable(row.revoked_at, row.revoked_at_set) ? 'revoked_at' : ''].filter((c) => c !== '');
    if (columns.length > 0) {
      // The kid is a public key id; the warning never carries the key material.
      this.Log.warn(`authn_key ${row.kid}: its ${columns.join(' and ')} is not a datetime the store can read; the key is not usable`);
    }
    return toRecord(row);
  }

  async revoke(owner: IdentityRef, kid: string, at: Date): Promise<'revoked' | 'already' | 'none'> {
    const row = await this.get(kid);
    if (!row || !sameRef(row.owner, owner)) {
      return 'none';
    }
    if (row.revokedAt) {
      return 'already';
    }
    const r = await AuthnKey.update({ revoked_at: DateTime.fromJSDate(at) })
      .where('kid', kid)
      .whereNull('revoked_at');
    return rowsAffected(r) > 0 ? 'revoked' : 'already';
  }

  async touch(kid: string, at: Date): Promise<void> {
    await AuthnKey.update({ last_used_at: DateTime.fromJSDate(at) }).where('kid', kid);
  }
}
