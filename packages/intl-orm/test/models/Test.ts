import { TestRelOneToMany } from './TestRelOneToMany';
import { IntlModelBase, Translate } from './../../src/index';
import { Primary, Connection, Model, HasMany } from '@spinajs/orm';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('test')
export class Test extends IntlModelBase {
  @Primary()
  public Id: number;

  @Translate()
  public Text: string;

  @HasMany(TestRelOneToMany)
  public Data: TestRelOneToMany[];
}
