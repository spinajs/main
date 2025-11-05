import { Connection, Model, MetadataModel } from '@spinajs/orm';
import _ from 'lodash';

/**
 * Unsafe metadata orm model
 * It can access all metadata without RBAC permission check.
 */
@Connection('sqlite')
@Model('users_metadata')
export class UserMetadata extends MetadataModel<UserMetadata> {
  public user_id: number;

  public Key : string;
}


 