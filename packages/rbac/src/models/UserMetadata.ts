import { BelongsTo, Connection, Model, MetadataModel, SingleRelation } from '@spinajs/orm';
import _ from 'lodash';
import type { User } from './User.js';
import { OrmResource, ResourceOwner } from '../decorators.js';

/**
 * Unsafe metadata orm model
 * It can access all metadata without RBAC permission check.
 */
@Connection('default')
@Model('users_metadata')
export class UserMetadataBase extends MetadataModel<UserMetadataBase> {

  protected _hidden: string[] = ['user_id', 'User'];

  @BelongsTo('User')
  public User: SingleRelation<User>;

  @ResourceOwner()
  public user_id: number;
}


@Connection('default')
@OrmResource('user.metadata')
export class UserMetadata extends UserMetadataBase {

}