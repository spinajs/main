import { Event } from '@spinajs/queue';
import { UserEvent } from './UserEvent.js';
import { User } from '../models/User.js';

/**
 * Emitted when `original` starts impersonating `target`. UserUUID (from the
 * base class) holds the impersonator's UUID — the actor who triggered the
 * event — and TargetUUID holds whoever they impersonated.
 */
@Event()
export class UserImpersonationStarted extends UserEvent {
  public TargetUUID: string;

  constructor(original: User, target: User) {
    super(original);
    this.TargetUUID = target.Uuid;
  }
}
