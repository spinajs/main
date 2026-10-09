import { BelongsTo, Connection, Hidden, Model, MetadataModel, SingleRelation } from '@spinajs/orm';
import _ from 'lodash';
import type { User } from './User.js';

/**
 * Unsafe metadata orm model
 * It can access all metadata without RBAC permission check.
 */
@Connection('default')
@Model('users_metadata')
export class UserMetadataBase extends MetadataModel<UserMetadataBase> {

  /**
   * Metadata keys that should be not visible when dehydrating User model
   * eg. security data, system data or any other internal variables that should not be exposed publicly
   *
   * NOTE: a different concept from `@Hidden()` below - these are metadata VALUES filtered by key
   * at runtime, not properties of this model.
   */
  public static _hiddenKeys: string[] = [];

  /**
   * The owner is hidden on both sides: a metadata row is always read through the user that owns
   * it, so echoing that user back would recurse, and `user_id` is an internal row id.
   */
  @Hidden()
  @BelongsTo('User')
  public User: SingleRelation<User>;

  @Hidden()
  public user_id: number;
}


@Connection('default')
@Model('users_metadata')
export class UserMetadata extends UserMetadataBase {

}