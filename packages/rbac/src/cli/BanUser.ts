import { UserUnbanned } from './../events/UserUnbanned';
import { QueueClient } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User';
import { UserBanned } from '../events/UserBanned';

@Command('rbac:user-ban', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('ban', ' true / false', false, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
export class BanUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  public async execute(idOrUuid: string, ban: boolean): Promise<void> {
    const result = await User.update({ IsBanned: ban }).where('Id', idOrUuid).orWhere('Uuid', idOrUuid);

    if (result.RowsAffected > 0) {
      // notify others
      if (ban) {
        this.Queue.emit(new UserBanned(idOrUuid));
      } else {
        this.Queue.emit(new UserUnbanned(idOrUuid));
      }

      this.Log.success(`User ban status changed to ${ban}`);
    } else {
      this.Log.warn(`No user with id: ${idOrUuid} found`);
    }
  }
}
