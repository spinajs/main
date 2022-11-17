import { UserDeactivated } from './../events/UserDeactivated';
//import { UserBannedMessage } from './../messages/UserBanned';
import { QueueClient } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User';
import { UserActivated } from '../events/UserActivated';

@Command('rbac:user-active', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('active', ' true / false', false, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
export class ActivateUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  public async execute(idOrUuid: string, active: boolean): Promise<void> {
    const result = await User.update({ IsActive: active }).where('Id', idOrUuid).orWhere('Uuid', idOrUuid);

    if (result.RowsAffected > 0) {
      // notify others
      if (active) {
        this.Queue.emit(new UserActivated(idOrUuid));
      } else {
        this.Queue.emit(new UserDeactivated(idOrUuid));
      }

      this.Log.success(`User activation status changed to ${active}`);
    } else {
      this.Log.warn(`No user with id: ${idOrUuid} found`);
    }
  }
}
