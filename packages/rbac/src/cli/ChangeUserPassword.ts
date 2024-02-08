import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Commands } from '../models/User.js';

@Command('rbac:user-change-password', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('newPassword', 'new password')
export class ChangeUserPassword extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, newPassword: string): Promise<void> {
    try {
      await Commands.changePassword(idOrUuid, newPassword);
      this.Log.success(`User ${idOrUuid} password changed`);
    } catch (e) {
      this.Log.error(`Error while changing user password ${idOrUuid} ${e.message}`);
    }
  }
}
