import { principalKey } from '@spinajs/authz';
import type { PrincipalRef } from '@spinajs/authz';
import { EXPIRED_PASSWORD_MARKER } from '@spinajs/authn-local';
import { AccountStatusSource } from '@spinajs/authz-rbac';
import { Injectable } from '@spinajs/di';

import { User } from '../models/User.js';

const LOOKUP_CHUNK = 100;

/**
 * Tells AuthzAdmin's last-holder check which users are in service: the row exists and is not soft-deleted, the
 * account is active and not banned (a timed ban counts until it ends), and its password does not hold authn-local's
 * expiry marker. Both an admin expiry and the `authn.local.expiration` job write that marker; a password past
 * `maxAgeDays` still logs in until the job marks it, so its age alone does not count. Any other principal type,
 * and a Uuid with no row, is not in service.
 */
@Injectable(AccountStatusSource)
export class UserAccountStatusSource extends AccountStatusSource {
  public async inService(refs: readonly PrincipalRef[]): Promise<ReadonlyMap<string, boolean>> {
    const answers = new Map<string, boolean>();
    const uuids = new Set<string>();
    for (const ref of refs) {
      answers.set(principalKey(ref), false);
      if (ref.type === 'user' && typeof ref.id === 'string') uuids.add(ref.id);
    }

    const ids = [...uuids];
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
      // The ban lives in the metadata, so a row read without it would pass as not banned.
      const rows = (await User.query()
        .withDeleted()
        .whereIn('Uuid', ids.slice(i, i + LOOKUP_CHUNK))
        .populate('Metadata')) as User[];
      for (const u of rows) {
        answers.set(principalKey({ type: 'user', id: u.Uuid }), inService(u));
      }
    }

    return answers;
  }
}

function inService(u: User): boolean {
  return !u.DeletedAt && Boolean(u.IsActive) && !u.IsBanned && u.Password !== EXPIRED_PASSWORD_MARKER;
}
