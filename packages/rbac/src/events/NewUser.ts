import { QueueEvent, Event } from '@spinajs/queue';
import { DateTime } from 'luxon';

@Event()
export class UserRegisteredMessage extends QueueEvent {
  public Uuid: string;

  public Email: string;

  public Login: string;

  public Role: string[];

  public UserCreatedAt: DateTime;

  public IsBanned: boolean;

  public IsActive: boolean;

  public Metadata: {};
}
