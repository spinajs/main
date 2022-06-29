import { ModelBase, Connection, Model, Primary } from '@spinajs/orm';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('intl_translations')
export class IntlTranslation extends ModelBase {
  @Primary()
  public Id: number;

  public Key: string;

  public Value: string;

  public Lang: string;
}
