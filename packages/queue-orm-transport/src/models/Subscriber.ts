import { Queue } from './Queue';
import { Event } from './Event';
import { ModelBase, Primary, Connection, Model, HasManyToMany, ManyToManyRelationList } from '@spinajs/orm';

/**
 * Base model for users used by auth and ACL system
 *
 * To add / extend fields simply extend this model and register as default user model in ACL service
 */
@Connection('orm-event-transport')
@Model('orm_event_transport__subscribers')
export class Subscriber extends ModelBase {
  @Primary()
  public Id: number;

  @Primary()
  public Name: string;

  @HasManyToMany(Queue, Event, 'Id', 'Id', 'orm_event_transport__event_Id', 'orm_event_transport__subscribers_Id')
  public Events: ManyToManyRelationList<Event>;
}
