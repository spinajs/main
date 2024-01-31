import { BelongsTo, Connection, Model, MetadataModel, SingleRelation } from '@spinajs/orm';
import _ from 'lodash';
import type { User } from './User.js';

@Connection('default')
@Model('users_metadata')
export class UserMetadata extends MetadataModel<UserMetadata> {
  @BelongsTo('User')
  public User: SingleRelation<User>;
}
