import { Subscriber } from './Subscriber';
import { ModelBase, Connection, Model, BelongsTo, SingleRelation } from '@spinajs/orm';
import type { Event } from './Event';
/**
 * Base model for users used by auth and ACL system
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('orm-event-transport')
@Model('orm_event_transport__queue')
export class Queue extends ModelBase {
  @BelongsTo('Event', 'orm_event_transport__event_Id', 'Id')
  public Event: SingleRelation<Event>;

  @BelongsTo('Subscriber', 'orm_event_transport__subscribers_Id', 'Id')
  public Subscriber: SingleRelation<Subscriber>;

  public Ack: boolean;
}
