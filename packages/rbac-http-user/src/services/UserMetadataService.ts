import { Injectable } from '@spinajs/di';
import { UserMetadata } from '@spinajs/rbac';
import { InsertBehaviour, SortOrder } from '@spinajs/orm';
import type { IFilterRequest, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { FilterableUserMetadata } from '../models/FilterableUserMetadata.js';
import type { UserMetadataDto } from '../dto/metadata-dto.js';

/**
 * Fallback page size. A request without a `limit` used to reach `take(0)`,
 * which the query builder rejects ( "take count should be a positive number" ),
 * so plain listing requests failed instead of returning the first page.
 */
export const DEFAULT_PAGE_SIZE = 10;

/**
 * Which column an "Id or Key" identifier addresses.
 *
 * `Id` is an integer column and `Key` a varchar one, so the two can never be compared against the
 * same value in one predicate without the database coercing across types. Digits mean the id — a
 * metadata key is a name (`user:niceName`, `2fa:enabled`), never a bare number — and anything else
 * means the key.
 *
 * Exported because the admin route's `@FromModel` lookup has to address the entry exactly the way
 * the write below does; the two disagreeing would turn a resolved entry into an update of nothing.
 */
export function addressedColumn(idOrKey: string | number): 'Id' | 'Key' {
  return typeof idOrKey === 'number' || /^\d+$/.test(idOrKey) ? 'Id' : 'Key';
}

/**
 * User metadata access, always scoped to one owner.
 *
 * The controller exposes each operation twice — once for the caller's own
 * metadata and once for an administrator addressing a user by UUID — and the
 * two differed only in where the owner id came from. Keeping the queries here
 * means the ownership predicate is written once.
 *
 * Ownership is filtered explicitly rather than left to the rbac query
 * middleware: metadata queries resolve to the unsafe base model, so no
 * automatic owner scoping fires for them.
 */
@Injectable()
export class UserMetadataService {
  /** Paginated, filtered, ordered listing of one user's metadata. */
  public list(ownerId: number, pagination?: PaginationDTO, order?: OrderDTO, filter?: IFilterRequest) {
    const limit = pagination?.limit || DEFAULT_PAGE_SIZE;

    return FilterableUserMetadata.select()
      .where('user_id', ownerId)
      .filter(filter?.filters ?? [], filter?.op)
      .take(limit)
      .skip(limit * (pagination?.page ?? 0))
      .order(order?.column ?? 'Id', order?.order ?? SortOrder.DESC);
  }

  /** A single entry of one user, by key. Rejects when absent. */
  public getByKey(ownerId: number, key: string) {
    return UserMetadata.where({
      Key: key,
      user_id: ownerId,
    }).firstOrFail();
  }

  /**
   * Insert an entry, or update it when the key already exists.
   *
   * Takes the DTO rather than a hydrated model: the model carries `user_id`, and exposing it on the
   * request body published an owner id that callers must not set — clients then had to invent one
   * to satisfy the generated schema. Ownership comes from the addressed user and nothing else.
   */
  public async upsert(ownerId: number, data: UserMetadataDto): Promise<void> {
    const entry = new UserMetadata();

    entry.Key = data.Key;
    // `Value` is a setter that derives `Type` from the JS type of what it is given, so the declared
    // type is assigned AFTER it — otherwise a 'json' or 'datetime' entry sent as a string would be
    // written as 'string'.
    entry.Value = data.Value;
    entry.Type = data.Type;
    entry.user_id = ownerId;

    await entry.insert(InsertBehaviour.InsertOrUpdate);
  }

  /**
   * Update an entry addressed by either its Id or its Key, always AND-ed with the ownership filter
   * so no caller can reach another user's entry.
   *
   * ONE column is compared, chosen by {@link addressedColumn} — never both in an `OR`. The previous
   * `Key = ? OR Id = ?` put a single value against columns of two different types, and a numeric
   * identifier then had to be coerced against the `Key` varchar:
   *
   *   - MySQL refuses that inside an UPDATE (`ER_TRUNCATED_WRONG_VALUE: Truncated incorrect DOUBLE
   *     value: 'user:phone'`), so every id-addressed update answered a 500;
   *   - databases that do coerce silently widen the match to any entry whose key reads as that
   *     number, so one update could rewrite two rows.
   */
  public async update(ownerId: number, idOrKey: string | number, data: UserMetadataDto): Promise<void> {
    await UserMetadata.update({
      Key: data.Key,
      Value: data.Value,
      Type: data.Type,
    })
      .where(addressedColumn(idOrKey), idOrKey)
      .andWhere('user_id', ownerId);
  }

  /**
   * Delete an entry by id, scoped to its owner.
   *
   * `destroy()` refuses to build an unbounded DELETE, so the entry id goes in
   * as the primary key and ownership is AND-ed on top of it — deleting by id
   * alone would let any caller remove anybody's entry.
   */
  public async delete(ownerId: number, id: number): Promise<void> {
    await UserMetadata.destroy(id).andWhere('user_id', ownerId);
  }
}
