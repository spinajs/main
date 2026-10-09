import { AuthzService, RelationResolver, SYSTEM, requestScope } from '@spinajs/authz';
import type { Principal, ResourceRef } from '@spinajs/authz';
import { DI, Injectable } from '@spinajs/di';

import { userModel } from './model-token.js';

const USER_METADATA = 'user.metadata';

/** The owner id (and the id, when stored) of a metadata row: any object with an integer `user_id`. */
function metadataRow(subject: unknown): { user_id: unknown; Id?: unknown } | undefined {
  if (subject === null || typeof subject !== 'object') {
    return undefined;
  }

  const owner = (subject as { user_id?: unknown }).user_id;
  const integer = (typeof owner === 'number' && Number.isSafeInteger(owner)) || (typeof owner === 'string' && /^\d+$/.test(owner));
  return integer ? (subject as { user_id: unknown; Id?: unknown }) : undefined;
}

/**
 * `owner` on `user.metadata`: the principal is the user whose row `user_id` names. The row decides: a principal id is the
 * user's Uuid (D4) and the row carries the numeric users.Id, so without a row, on a row that is not a metadata row, or
 * with a ref naming another row, it never holds. `onBehalfOf` is not read, as for `self`.
 */
@Injectable(RelationResolver)
export class UserMetadataOwnerRelation extends RelationResolver {
  public readonly type = USER_METADATA;
  public readonly relation = 'owner';

  public async holds(principal: Principal, ref: ResourceRef, subject?: unknown): Promise<boolean> {
    if (principal.type !== 'user' || typeof principal.id !== 'string' || principal.id === '') {
      return false;
    }

    const row = metadataRow(subject);
    if (!row) {
      return false;
    }

    if (ref.id !== undefined && ref.id !== null && (row.Id === undefined || row.Id === null || String(row.Id) !== String(ref.id))) {
      return false;
    }

    const id = await this.userIdOf(principal.id);
    return id !== undefined && id !== null && String(id) === String(row.user_id);
  }

  /** users.Id of the user `uuid`, read as SYSTEM and once per request: a list decides each of its rows. */
  protected userIdOf(uuid: string): Promise<unknown> {
    const cache = requestScope().cache ?? new Map<string, unknown>();
    const key = `users:metadata-owner:${uuid}`;
    let found = cache.get(key) as Promise<unknown> | undefined;

    if (!found) {
      found = (async () => {
        const user = await this.userOf(uuid);
        return user && !user.DeletedAt ? user.Id : undefined;
      })();
      cache.set(key, found);
      found.catch(() => cache.delete(key));
    }

    return found;
  }

  /** The users row of `uuid`, read as SYSTEM. */
  protected async userOf(uuid: string): Promise<{ Id?: unknown; DeletedAt?: unknown } | undefined> {
    const authz = (await DI.resolve(AuthzService)) as AuthzService;
    return (await authz.runAs(SYSTEM, 'user-metadata-owner', () => userModel().query().where('Uuid', uuid).first())) as { Id?: unknown; DeletedAt?: unknown } | undefined;
  }
}
