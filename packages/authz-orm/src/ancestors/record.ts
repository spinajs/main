import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

import { AUTHZ_RESOURCE_ANCESTOR_TABLE } from './table.js';
import type { AncestorRow } from './table.js';

/** An `authz_resource_ancestor` row. */
@Connection(AUTHZ_CONNECTION)
@Model(AUTHZ_RESOURCE_ANCESTOR_TABLE)
export class AncestorRecord extends ModelBase<AncestorRecord> implements AncestorRow {
  @Primary({ generated: 'assigned' })
  public resource_type!: string;

  // A resource id may be '', which `generated: 'assigned'` refuses.
  @Primary()
  public resource_id!: string;

  @Primary({ generated: 'assigned' })
  public ancestor_type!: string;

  @Primary()
  public ancestor_id!: string;

  public depth!: number;
}
