import { ModelBase, Connection, Model } from '@spinajs/orm';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('intl_resources')
export class IntlResource extends ModelBase {
  public ResourceId: number;

  public Resource: string;

  public Column: string;

  public Lang: string;

  public Value: string;
}
