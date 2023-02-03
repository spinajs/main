import { Translatable } from '../../src/model.js';
import { Translate } from '../../src/decorators.js';
import { Primary, Connection, Model, ModelBase } from '@spinajs/orm';
import { use } from 'typescript-mix';

export interface Test extends Translatable {}

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('owner2')
export class Owner2 extends ModelBase {
  @use(Translatable) this: any;

  @Primary()
  public Id: number;

  @Translate()
  public Text: string;

  
}
