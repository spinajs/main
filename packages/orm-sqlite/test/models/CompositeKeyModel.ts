import { Connection, HasMany, Model, ModelBase, Primary, Relation } from '@spinajs/orm';
import { CompositeChild } from './CompositeChild.js';

@Connection('sqlite')
@Model('composite_key_model')
export class CompositeKeyModel extends ModelBase {
  @Primary()
  public TenantId: number;

  @Primary()
  public Code: string;

  public Name: string;

  // primaryKey MUST be named: a relation joins on one column pair, and a composite-key model
  // has no defensible default (see _relationDefaultKey).
  @HasMany(CompositeChild, { primaryKey: 'TenantId', foreignKey: 'tenant_id' })
  public Children: Relation<CompositeChild, CompositeKeyModel>;
}
