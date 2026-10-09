import { Injectable } from '@spinajs/di';
import { Forbidden, ResourceNotFound, InvalidArgument } from '@spinajs/exceptions';
import { UserMetadataBase, assertNoProtectedMetadata, isReservedMetadataKey } from '@spinajs/users';
import { InsertBehaviour, SortOrder } from '@spinajs/orm';
import type { IFilterRequest, OrderDTO, PaginationDTO } from '@spinajs/orm-http';
import { FilterableUserMetadata } from '../models/FilterableUserMetadata.js';
import type { UserMetadataDto } from '../dto/metadata-dto.js';
import type { MetadataScope } from './metadata-scope.js';

/**
 * Fallback page size. A request without a `limit` used to reach `take(0)`,
 * which the query builder rejects ( "take count should be a positive number" ),
 * so plain listing requests failed instead of returning the first page.
 */
export const DEFAULT_PAGE_SIZE = 10;

const READ = 'user.metadata:read';
const CREATE = 'user.metadata:create';
const UPDATE = 'user.metadata:update';
const DELETE = 'user.metadata:delete';

// `order.column` reaches the query as an identifier: an unknown column would be a driver error (500), not a 400.
const SORTABLE_COLUMNS = ['Id', 'Key', 'Type'];

function sortColumn(order?: OrderDTO): string {
  const column = order?.column;
  if (!column) {
    return 'Id';
  }
  if (!SORTABLE_COLUMNS.includes(column)) {
    throw new InvalidArgument(`Cannot sort by '${column}'. Sortable columns are: ${SORTABLE_COLUMNS.join(', ')}`);
  }
  return column;
}

/**
 * Which column an "Id or Key" identifier addresses.
 *
 * `Id` is an integer column and `Key` a varchar one, so the two can never be compared against the
 * same value in one predicate without the database coercing across types. Digits mean the id — a
 * metadata key is a name (`user:niceName`, `2fa:enabled`), never a bare number — and anything else
 * means the key.
 */
export function addressedColumn(idOrKey: string | number): 'Id' | 'Key' {
  return typeof idOrKey === 'number' || /^\d+$/.test(idOrKey) ? 'Id' : 'Key';
}

const notFound = () => new ResourceNotFound('Metadata entry not found');

/**
 * User metadata access, always scoped to one owner ({@link MetadataScope}).
 *
 * The controller exposes each operation twice — once for the caller's own metadata and once for a
 * user addressed by UUID — and the two differ only in where the scope comes from. Ownership is a
 * `user_id` predicate on every query, and every row the caller reads or writes is decided by
 * `scope.admits`, so a conditional `@Access` decision is applied on the row.
 *
 * The queries use the base metadata model and add no model-level scope: the service decides each row itself.
 *
 * Reserved keys ({@link isReservedMetadataKey}: 2FA secrets, reset and invite tokens, ban and
 * throttle state) do not exist for this API (design A12, SR-01, SR-02): no list shows them, and
 * a read, update or delete that addresses one answers 404 like a missing entry. Every check runs
 * on the key of the row the database returned too, not only on the key the caller sent, because
 * a case- or accent-insensitive collation lets another spelling address a reserved row.
 */
@Injectable()
export class UserMetadataService {
  /** Paginated, filtered, ordered listing of one user's metadata, without reserved keys and rows the caller may not read. */
  public async list(scope: MetadataScope, pagination?: PaginationDTO, order?: OrderDTO, filter?: IFilterRequest) {
    const limit = pagination?.limit || DEFAULT_PAGE_SIZE;
    const column = sortColumn(order);

    // Excluded in the query, not after it, so a page holds `limit` visible entries.
    const reserved = (await this.rowsOf(scope.ownerId)).filter((m) => isReservedMetadataKey(m.Key)).map((m) => m.Id);

    const query = FilterableUserMetadata.select().where('user_id', scope.ownerId);

    if (reserved.length > 0) {
      query.whereNotIn('Id', reserved);
    }

    const rows = await query
      .filter(filter?.filters ?? [], filter?.op)
      .take(limit)
      .skip(limit * (pagination?.page ?? 0))
      .order(column, order?.order ?? SortOrder.DESC);

    // A reserved row written between the two queries.
    const visible = rows.filter((m) => !isReservedMetadataKey(m.Key));
    const admitted = await Promise.all(visible.map((m) => scope.admits(READ, m)));
    return visible.filter((_, i) => admitted[i]);
  }

  /** A single entry of one user, by key. Rejects with 404 when absent or reserved, 403 when the caller may not read it. */
  public async getByKey(scope: MetadataScope, key: string): Promise<UserMetadataBase> {
    const entry = await this.addressed(scope.ownerId, String(key), 'Key');
    await this.require(scope, READ, entry);
    return entry;
  }

  /**
   * Insert an entry, or update it when the key already exists: create is checked on the new entry,
   * and update on every stored row the key overwrites.
   *
   * Takes the DTO rather than a hydrated model: the model carries `user_id`, and exposing it on the
   * request body published an owner id that callers must not set — clients then had to invent one
   * to satisfy the generated schema. Ownership comes from the addressed user and nothing else.
   */
  public async upsert(scope: MetadataScope, data: UserMetadataDto): Promise<void> {
    // This route is generic enough to reach the account's security keys (invite marker, ban, 2FA, …);
    // an admin has dedicated routes for those, so the generic API must refuse them for everyone.
    assertNoProtectedMetadata({ [data.Key]: data.Value });

    for (const stored of await this.twinsOf(scope.ownerId, data.Key)) {
      await this.require(scope, UPDATE, stored);
    }

    const entry = this.entryOf(scope.ownerId, data);
    await this.require(scope, CREATE, entry);

    await entry.insert(InsertBehaviour.InsertOrUpdate);
  }

  /**
   * Update an entry addressed by either its Id or its Key, always AND-ed with the ownership filter
   * so no caller can reach another user's entry. Rejects with 404 when the entry is absent or
   * reserved, 403 when the caller may not update the entry as it is or as the update leaves it.
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
  public async update(scope: MetadataScope, idOrKey: string | number, data: UserMetadataDto): Promise<void> {
    // The body can rewrite an existing (unprotected) entry's Key to a protected one, so the same
    // guard as upsert() applies here regardless of which entry is currently addressed.
    assertNoProtectedMetadata({ [data.Key]: data.Value });

    const entry = await this.addressed(scope.ownerId, idOrKey, addressedColumn(idOrKey));
    // Called for its throw only: a Key the database matches to a reserved row is refused.
    await this.twinsOf(scope.ownerId, data.Key);

    await this.require(scope, UPDATE, entry);
    await this.require(scope, UPDATE, Object.assign(this.entryOf(scope.ownerId, data), { Id: entry.Id }));

    await UserMetadataBase.update({
      Key: data.Key,
      Value: data.Value,
      Type: data.Type,
    })
      .where('Id', entry.Id)
      .andWhere('user_id', scope.ownerId);
  }

  /**
   * Delete an entry by id, scoped to its owner. Rejects with 404 when the entry is absent or
   * reserved, 403 when the caller may not delete it.
   *
   * `destroy()` refuses to build an unbounded DELETE, so the entry id goes in
   * as the primary key and ownership is AND-ed on top of it — deleting by id
   * alone would let any caller remove anybody's entry.
   */
  public async delete(scope: MetadataScope, id: number): Promise<void> {
    const entry = await this.addressed(scope.ownerId, id, 'Id');
    await this.require(scope, DELETE, entry);

    await UserMetadataBase.destroy(entry.Id).andWhere('user_id', scope.ownerId);
  }

  private async require(scope: MetadataScope, permission: string, row: UserMetadataBase): Promise<void> {
    if (!(await scope.admits(permission, row))) {
      throw new Forbidden(`${permission} is not granted on this metadata entry`);
    }
  }

  /** The entry a write leaves, owned by `ownerId`. */
  private entryOf(ownerId: number, data: UserMetadataDto): UserMetadataBase {
    const entry = new UserMetadataBase();

    entry.Key = data.Key;
    // `Value` is a setter that derives `Type` from the JS type of what it is given, so the declared
    // type is assigned AFTER it — otherwise a 'json' or 'datetime' entry sent as a string would be
    // written as 'string'.
    entry.Value = data.Value;
    entry.Type = data.Type;
    entry.user_id = ownerId;

    return entry;
  }

  private rowsOf(ownerId: number) {
    return UserMetadataBase.where('user_id', ownerId) as unknown as Promise<UserMetadataBase[]>;
  }

  /** The one visible entry the identifier addresses within the owner's metadata, or a 404. */
  private async addressed(ownerId: number, idOrKey: string | number, column: 'Id' | 'Key'): Promise<UserMetadataBase> {
    if (column === 'Key' && isReservedMetadataKey(String(idOrKey))) {
      throw notFound();
    }

    const rows = (await (UserMetadataBase.where(column, idOrKey).andWhere('user_id', ownerId) as unknown as Promise<UserMetadataBase[]>)) ?? [];

    if (rows.length !== 1 || isReservedMetadataKey(rows[0].Key)) {
      throw notFound();
    }

    return rows[0];
  }

  /**
   * The owner's stored rows the database matches to `key`. Refuses a key that matches a reserved
   * row, which a case- or accent-insensitive collation does for spellings the key check lets
   * through (`2fá:enabled` against `2fa:enabled`); `InsertOrUpdate` would then overwrite that row.
   */
  private async twinsOf(ownerId: number, key: string): Promise<UserMetadataBase[]> {
    const twins = (await (UserMetadataBase.where('Key', key).andWhere('user_id', ownerId) as unknown as Promise<UserMetadataBase[]>)) ?? [];

    if (twins.some((m) => isReservedMetadataKey(m.Key))) {
      throw new InvalidArgument(`Protected metadata keys cannot be set directly: ${key}`);
    }

    return twins;
  }
}
