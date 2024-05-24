import { ResourceNotFound } from '@spinajs/exceptions';
import { QueueService } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { deleteUser } from '../actions.js';

@Command('rbac:user-delete', 'Deletes user from database permanently')
@Argument('idOrUuid', 'numeric id or uuid')
export class DeleteUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  public async execute(idOrUuid: string): Promise<void> {
    try {

      await deleteUser(idOrUuid); 
      this.Log.success(`User ${idOrUuid} deleted`);
    } catch (e) {
      if (e instanceof ResourceNotFound) {
        this.Log.error(`User ${idOrUuid} not found`);
      } else {
        this.Log.error(`Error while deleting user ${idOrUuid} ${e.message}`);
      }
    }
  }
}
