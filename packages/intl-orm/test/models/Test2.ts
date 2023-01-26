import { Translatable } from '../../src/model.js';
import { Translate } from '../../src/decorators.js';
import { Primary, Connection, Model, ModelBase, BelongsTo, SingleRelation } from '@spinajs/orm';
import { use } from 'typescript-mix';
import { Owner } from './Owner.js';

export interface Test extends Translatable {}

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('test2')
export class Test2 extends ModelBase {
  @use(Translatable) this: any;

  @Primary()
  public Id: number;

  @Translate()
  public Text: string;

  @BelongsTo(Owner)
  public Owner: SingleRelation<Owner>;
}
