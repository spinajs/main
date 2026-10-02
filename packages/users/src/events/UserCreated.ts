import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { DateTime } from 'luxon';
import type { User } from '../models/User.js';

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

  constructor(user: User) {
    super(user);

    this.Uuid = user.Uuid;
    this.Email = user.Email;
    this.Login = user.Login;
    this.Role = [...(user.Role ?? [])];
    this.RegisteredAt = user.RegisteredAt;
    this.IsBanned = user.IsBanned;
    this.IsActive = user.IsActive;

    // deliberately empty: metadata may hold credentials ( reset token, 2fa
    // secret ) that must never ride a queue payload
    this.Metadata = {};
  }
}
