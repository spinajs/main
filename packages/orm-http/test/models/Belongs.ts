import { Primary, Connection, Model, ModelBase } from '@spinajs/orm';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('belongs')
export class Belongs extends ModelBase {
  @Primary()
  public Id: number;

  public Text: string;
}
