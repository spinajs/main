//import { UserBannedMessage } from './../messages/UserBanned';
import { ResourceNotFound } from '@spinajs/exceptions';
import { QueueClient } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User';

@Command('rbac:user-active', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('active', ' true / false', false, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
export class CreateUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  public async execute(idOrUuid: string, active: boolean): Promise<void> {
    const user = await User.where('Id', idOrUuid).orWhere('Uuid', idOrUuid).firstOrThrow(new ResourceNotFound(`user with given id/uuid not found in database`));

    user.IsActive = active;
    await user.update();

    // notify others about user creation
    //this.Queue.dispatch(new UserBannedMessage(user, 'rbac:user:active'));

    this.Log.success('User active status changed');
  }
}
