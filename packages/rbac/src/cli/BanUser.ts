//import { UserBannedMessage } from './../messages/UserBanned';
import { ResourceNotFound } from '@spinajs/exceptions';
import { QueueClient } from '@spinajs/queue';
 
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User';

@Command('rbac:user-ban', 'Bans or unbans user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('ban', ' true / false', false, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
export class CreateUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  public async execute(idOrUuid: string, ban: boolean): Promise<void> {
    const user = await User.where('Id', idOrUuid).orWhere('Uuid', idOrUuid).firstOrThrow(new ResourceNotFound(`user with given id/uuid not found in database`));

    user.IsBanned = ban;
    await user.update();

    // notify others about user creation
    //this.Queue.dispatch(new UserBannedMessage(user, 'rbac:user:banned'));

    this.Log.success('User ban status changed');
  }
}
