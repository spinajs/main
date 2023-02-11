import { ResourceNotFound } from '@spinajs/exceptions';
import { QueueService } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { User } from '../models/User.js';
import { UserDeleted } from '../events/UserDeleted.js';

@Command('rbac:user-delete', 'Deletes user from database permanently')
@Argument('idOrUuid', 'numeric id or uuid')
export class DeleteUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  public async execute(idOrUuid: string): Promise<void> {
    const result = await User.where('Id', idOrUuid).orWhere('Uuid', idOrUuid).firstOrThrow(new ResourceNotFound('User with given id or uuid not found in db'));

    await result.destroy();

    this.Queue.emit(new UserDeleted(idOrUuid));

    this.Log.success(`User deleted sucessyfully`);
  }
}
