import { Belongs } from './Belongs.js';
import { Primary, Connection, Model, ModelBase, BelongsTo, Relation, HasMany, SingleRelation } from '@spinajs/orm';
import { Test2 } from './Test2.js';

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

  public user : number;

  @HasMany(Test2, {
    foreignKey: 'test_id',
    primaryKey: 'Id',
  })
  public TestsTwos: Relation<Test2, Test>;
}
