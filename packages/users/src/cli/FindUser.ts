import { Log, Logger } from '@spinajs/log';
import { Option, CliCommand, Command } from '@spinajs/cli';
import { User } from '../models/User.js';

@Command('rbac:user-find', 'Finds user with given identifier')
@Option('-i, --identifier <idOrUuid>', false, 'numeric id or uuid')
export class FindUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(identifier: string): Promise<void> {
    const user = await User.getByAnything(identifier);

    if (user) {
      this.Log.info(`User : ${user.Id}, ${user.Uuid}, email: ${user.Email}, login: ${user.Login}, active: ${user.IsActive}, CreatedAt: ${user.CreatedAt.toISO()}, LastLogin: ${user.LastLoginAt.toISO()}`);
      return;
    }

    this.Log.error(`User not found`);
  }
}
