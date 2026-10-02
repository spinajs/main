import { ResourceNotFound } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { Command, Option } from '@spinajs/cli';
import { RbacCliCommand } from './RbacCliCommand.js';
import { getUser } from '../actions.js';

@Command('rbac:user-find', 'Finds user with given identifier')
@Option('-i, --identifier <identifier>', true, 'numeric id, uuid, email or login')
export class FindUser extends RbacCliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(options: { identifier: string }): Promise<void> {
    try {
      // `getUser`, not `User` itself: it queries the configured user model, which an app may extend.
      const user = await getUser(options.identifier);

      this.Log.info(`User : ${user.Id}, ${user.Uuid}, email: ${user.Email}, login: ${user.Login}, active: ${user.IsActive}, CreatedAt: ${user.CreatedAt?.toISO() ?? '-'}, LastLogin: ${user.LastLoginAt?.toISO() ?? '-'}`);
    } catch (e) {
      this.Log.error(e instanceof ResourceNotFound ? `User ${options.identifier} not found` : `Error while finding user ${options.identifier} ${(e as Error).message}`);
    }
  }
}
