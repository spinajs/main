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
   * Ownership is forced onto the model — a `user_id` arriving in the request
   * body is never trusted.
   */
  public async upsert(ownerId: number, metadata: UserMetadata): Promise<void> {
    metadata.user_id = ownerId;
    await metadata.insert(InsertBehaviour.InsertOrUpdate);
  }

  /**
   * Update an entry addressed by either its Id or its Key.
   *
   * The Key/Id lookup is grouped and AND-ed with the ownership filter. Without
   * the grouping the flat `Key = ? OR Id = ? AND user_id = ?` binds as
   * `Key = ? OR (Id = ? AND user_id = ?)`, which would let any caller update
   * another user's entry by its Key.
   */
  public async update(ownerId: number, idOrKey: string | number, data: UserMetadataDto): Promise<void> {
    await UserMetadata.update({
      Key: data.Key,
      Value: data.Value,
      Type: data.Type,
    })
      .where(function () {
        this.where('Key', idOrKey).orWhere('Id', idOrKey);
      })
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
