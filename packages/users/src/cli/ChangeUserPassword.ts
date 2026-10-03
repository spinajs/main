import { Log, Logger } from '@spinajs/log';
import { Argument, Command } from '@spinajs/cli';
import { RbacCliCommand } from './RbacCliCommand.js';
import { changeUserPassword, getUser } from '../actions.js';

@Command('rbac:user-change-password', 'Changes user password')
@Argument('idOrUuid', true,'numeric id or uuid')
@Argument('newPassword', true, 'new password')
export class ChangeUserPassword extends RbacCliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, newPassword: string): Promise<void> {
    try {
      const user = await getUser(idOrUuid);
      await changeUserPassword(user, newPassword);
      this.Log.success(`User ${idOrUuid} password changed`);
    } catch (e) {
      this.Log.error(`Error while changing user password ${idOrUuid} ${e.message}`);
    }
  }
}
