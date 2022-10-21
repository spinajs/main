import { QueueMessage } from '@spinajs/queue';
import { User } from '../models/User';
export class UserActivatedMessage extends QueueMessage {
  public Uuid: string;

  public Active: boolean;

  constructor(user: User, channel: string) {
    super(channel);

    this.Active = user.IsActive;
    this.Uuid = user.Uuid;
  }
}
