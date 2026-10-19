import { AUTHZ_CONNECTION } from '@spinajs/authz';
import type { ScopeAttributeLeaf } from '@spinajs/authz';
import { Connection, DateTime as DateTimeColumn, Json, Model, ModelBase, Primary } from '@spinajs/orm';
import { DateTime } from 'luxon';

export const SCOPE_ATTRIBUTE_TABLE = 'authz_scope_attribute';
export const SCOPE_ATTRIBUTE_VERSION_TABLE = 'authz_scope_attribute_version';

/** An `authz_scope_attribute` row: one scalar leaf of a scope node's attributes. */
export interface ScopeAttributeFields {
  readonly scope_type: string;
  readonly scope_id: string;
  readonly path: string;
  readonly value_json: ScopeAttributeLeaf;
  readonly value_text: string | null;
  readonly value_num: number | null;
  readonly updated_by: string | null;
  readonly updated_at: DateTime;
}

@Connection(AUTHZ_CONNECTION)
@Model(SCOPE_ATTRIBUTE_TABLE)
export class ScopeAttributeRecord extends ModelBase<ScopeAttributeRecord> implements ScopeAttributeFields {
  @Primary({ generated: 'assigned' })
  public scope_type!: string;

  // '' for $global, which `generated: 'assigned'` refuses.
  @Primary()
  public scope_id!: string;

  @Primary({ generated: 'assigned' })
  public path!: string;

  @Json()
  public value_json!: ScopeAttributeLeaf;

  public value_text!: string | null;

  public value_num!: number | null;

  public updated_by!: string | null;

  @DateTimeColumn()
  public updated_at!: DateTime;
}

/** The one `authz_scope_attribute_version` row. */
@Connection(AUTHZ_CONNECTION)
@Model(SCOPE_ATTRIBUTE_VERSION_TABLE)
export class ScopeAttributeVersionRecord extends ModelBase<ScopeAttributeVersionRecord> {
  @Primary({ generated: 'assigned' })
  public id!: number;

  public version!: string;

  @DateTimeColumn()
  public updated_at!: DateTime;
}
