import { QueueMessage } from '@spinajs/queue';
import { User } from '../models/User';
export class UserBannedMessage extends QueueMessage {
  public Uuid: string;

  public Banned: boolean;

  constructor(user: User, channel: string) {
    super(channel);

    this.Banned = user.IsBanned;
    this.Uuid = user.Uuid;
  }
}
