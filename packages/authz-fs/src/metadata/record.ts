import { Connection, DateTime as DateTimeColumn, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

import { FS_METADATA_CONNECTION } from './connection.js';

export const FS_OBJECT_TABLE = 'fs_object';

/** An `fs_object` row; `tags` holds whatever JSON the column has, which the store checks before use. */
export interface FsObjectFields {
  readonly fs: string;
  readonly path: string;
  readonly owner_type: string | null;
  readonly owner_id: string | null;
  readonly scope_type: string | null;
  readonly scope_id: string | null;
  readonly tags: unknown;
  readonly created_at: DateTime;
  readonly updated_at: DateTime;
}

@Connection(FS_METADATA_CONNECTION)
@Model(FS_OBJECT_TABLE)
export class FsObjectRecord extends ModelBase<FsObjectRecord> implements FsObjectFields {
  @Primary({ generated: 'assigned' })
  public fs!: string;

  @Primary({ generated: 'assigned' })
  public path!: string;

  public owner_type!: string | null;

  public owner_id!: string | null;

  public scope_type!: string | null;

  public scope_id!: string | null;

  @Json()
  public tags!: unknown;

  @DateTimeColumn()
  public created_at!: DateTime;

  @DateTimeColumn()
  public updated_at!: DateTime;
}
