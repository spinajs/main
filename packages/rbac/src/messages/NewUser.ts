import { QueueMessage } from '@spinajs/queue';
import { DateTime } from 'luxon';
import { User } from '../models/User';
export class NewUserMessage extends QueueMessage {
  public Uuid: string;

  public Email: string;

  public Login: string;

  public Role: string[];

  public UserCreatedAt: DateTime;

  public IsBanned: boolean;

  public IsActive: boolean;

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
