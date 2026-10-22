import { ModelBase, Connection, Model, Primary } from '@spinajs/orm';

/**
 * Base modele for users used by ACL
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('default')
@Model('intl_resources')
export class IntlResource extends ModelBase {
  // Composite key mirrors the unique index intl_resources_idx; it gives InsertOrUpdate its conflict target
  @Primary({ generated: 'assigned' })
  public ResourceId: number;

  @Primary({ generated: 'assigned' })
  public Resource: string;

  @Primary({ generated: 'assigned' })
  public Column: string;

  @Primary({ generated: 'assigned' })
  public Lang: string;

  public Value: string;
}
