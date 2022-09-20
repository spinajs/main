import { Message, Serialize } from '@spinajs/Queue';
import { DateTime } from 'luxon';
import { User } from '../models/User';
export class NewUserMessage extends Message {
  @Serialize()
  public Uuid: string;

  @Serialize()
  public Email: string;

  @Serialize()
  public Login: string;

  @Serialize()
  public Role: string[];

  @Serialize()
  public UserCreatedAt: DateTime;

  @Serialize()
  public IsBanned: boolean;

  @Serialize()
  public IsActive: boolean;

  @Serialize()
  public Metadata: Map<string, any> = new Map<string, any>();

  constructor(user: User, channel: string) {
    super(channel);

    this.Email = user.Email;
    this.Login = user.Login;
    this.Role = user.Role;
    this.UserCreatedAt = user.CreatedAt;
    this.IsBanned = user.IsBanned;
    this.IsActive = user.IsActive;

    for (const m of user.Metadata) {
      this.Metadata.set(m.Key, m.Value);
    }
  }
}
