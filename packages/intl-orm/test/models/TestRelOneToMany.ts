import { Translate } from '../../src/index';
import { ModelBase, Primary, Connection, Model } from '@spinajs/orm';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('test_rel_many')
export class TestRelOneToMany extends ModelBase {
  @Primary()
  public Id: number;

  @Translate()
  public Text: string;
}
