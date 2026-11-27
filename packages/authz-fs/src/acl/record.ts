import { Connection, DateTime as DateTimeColumn, Model, ModelBase, Primary } from '@spinajs/orm';
// A value import: @DateTime() reads the property's design type.
import { DateTime } from 'luxon';

import { FS_ACL_CONNECTION } from '../access-config/acl-config.js';
import { FS_ACL_TABLE } from './shared.js';

/** An `fs_acl` row (migration AuthzFsAcl_2026_10_17_00_00_00). */
@Connection(FS_ACL_CONNECTION)
@Model(FS_ACL_TABLE)
export class FsAclRecord extends ModelBase<FsAclRecord> {
  // The table holds the UUID as 36 characters of text, so the key is assigned, not a @Uuid() column of 16 bytes.
  @Primary({ generated: 'assigned' })
  public id!: string;

  public fs!: string;

  public path!: string;

  public path_hash!: string;

  public subject_key!: string;

  public relation!: string;

  @DateTimeColumn({ nullable: true })
  public expires_at!: DateTime | null;

  public granted_by!: string | null;

  @DateTimeColumn()
  public created_at!: DateTime;
}
