import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { User } from '../models/User.js';

/**
 * Emitted when an active impersonation ends (explicit stop, logout while
 * impersonating, or session expiry handling). UserUUID is the impersonator
 * who initiated the impersonation; TargetUUID is whoever they were acting as.
 */
@Event()
export class UserImpersonationEnded extends UserEvent {
  public TargetUUID: string;

  constructor(original: User, target: User) {
    super(original);
    this.TargetUUID = target.Uuid;
  }
}
