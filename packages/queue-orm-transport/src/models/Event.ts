import { DateTime } from 'luxon';
import { ModelBase, Primary, Connection, Model, CreatedAt, Json } from '@spinajs/orm';

/**
 * Base model for users used by auth and ACL system
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('orm-event-transport')
@Model('orm_event_transport__event')
export class Event extends ModelBase {
  @Primary()
  public Id: number;

  public Channel: string;

  @CreatedAt()
  public CreatedAt: DateTime;

  @Json()
  public Value: unknown;
}
