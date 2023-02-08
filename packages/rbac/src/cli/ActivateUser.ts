import { UserDeactivated } from './../events/UserDeactivated.js';
//import { UserBannedMessage } from './../messages/UserBanned';
import { QueueService } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User.js';
import { UserActivated } from '../events/UserActivated.js';

@Command('rbac:user-activate', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('active', ' true / false', false, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
export class ActivateUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  public async execute(idOrUuid: string, active: boolean): Promise<void> {
    const result = await User.update({ IsActive: active }).where('Id', idOrUuid).orWhere('Uuid', idOrUuid);

    if (result.RowsAffected > 0) {
      const event = active ? new UserActivated(idOrUuid) : new UserDeactivated(idOrUuid);

      this.Queue.emit(event);

      this.Log.success(`User activation status changed to ${active}`);
    } else {
      this.Log.warn(`No user with id: ${idOrUuid} found`);
    }
  }
}
