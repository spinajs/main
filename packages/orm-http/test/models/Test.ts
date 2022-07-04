import { Belongs } from './Belongs';
import { Primary, Connection, Model, ModelBase, BelongsTo, Relation, HasMany, SingleRelation } from '@spinajs/orm';
import { Test2 } from './Test2';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('test')
export class Test extends ModelBase {
  @Primary()
  public Id: number;

  public Text: string;

  @BelongsTo(Belongs)
  public Belongs: SingleRelation<Belongs>;

  @HasMany(Test2, 'test_id', 'Id')
  public TestsTwos: Relation<Test2>;
}
