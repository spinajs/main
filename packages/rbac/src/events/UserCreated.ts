import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { DateTime } from 'luxon';

@Event()
export class UserCreated extends UserEvent {
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
