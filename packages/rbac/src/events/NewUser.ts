import { QueueEvent, Event } from '@spinajs/queue';
import { DateTime } from 'luxon';

@Event()
export class UserCreated extends QueueEvent {
  public Uuid: string;

  public Email: string;

  public Login: string;

  public Role: string[];

  public RegisteredAt: DateTime;

  public IsBanned: boolean;

  public IsActive: boolean;

  public Metadata: {};

  constructor(data: any) {
    super(data);
  }
}
