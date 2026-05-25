import { Connection, Primary, Model, HasMany } from '../../../src/decorators.js';
import { ModelBase } from '../../../src/model.js';
import { MetadataRelation } from '../../../src/metadata.js';
import { LowercaseMeta } from './LowercaseMeta.js';

@Connection('sqlite')
@Model('lowercase_owner')
export class LowercaseMetaOwner extends ModelBase {
  @Primary()
  public id: number;

  @HasMany(LowercaseMeta, { foreignKey: 'owner_id', primaryKey: 'id' })
  public Metadata: MetadataRelation<LowercaseMeta, LowercaseMetaOwner>;
}
