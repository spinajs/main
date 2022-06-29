import { Translate } from './../../src/decorators';
import { Primary, Connection, Model } from '@spinajs/orm';
import { IntlModelBase } from './../../src/model';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('test_rel_many')
export class TestRelOneToMany extends IntlModelBase {
  @Primary()
  public Id: number;

  @Translate()
  public Text: string;
}
