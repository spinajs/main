import { MessageBase, Serialize } from '@spinajs/Queue';
import { User } from '../models/User';
export class UserBannedMessage extends MessageBase {
  @Serialize()
  public Uuid: string;

  @Serialize()
  public Banned: boolean;

  constructor(user: User, channel: string) {
    super(channel);

    this.Banned = user.IsBanned;
    this.Uuid = user.Uuid;
  }
}