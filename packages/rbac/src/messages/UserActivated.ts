import { MessageBase, Serialize } from '@spinajs/Queue';
import { User } from '../models/User';
export class UserActivatedMessage extends MessageBase {
  @Serialize()
  public Uuid: string;

  @Serialize()
  public Active: boolean;

  constructor(user: User, channel: string) {
    super(channel);

    this.Active = user.IsActive;
    this.Uuid = user.Uuid;
  }
}