import { Log, Logger } from '@spinajs/log';
import { Argument, Command } from '@spinajs/cli';
import { RbacCliCommand } from './RbacCliCommand.js';
import { ban, unban } from '../actions.js';

@Command('rbac:user-ban', 'Bans or unbans user')
@Argument('idOrUuid', true, 'numeric id or uuid')
@Argument('ban', true, ' true / false', undefined, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
@Argument('duration', false, 'how long should ban last ( in minutes )', 24 * 60, (opt: string) => parseInt(opt))
@Argument('reason', false, 'reason for ban')
export class BanUser extends RbacCliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, banOrUnban: boolean, duration: number, reason: string): Promise<void> {
    try {
      // ban() takes seconds
      await (banOrUnban ? ban(idOrUuid, reason, duration * 60) : unban(idOrUuid));

      this.Log.success({ user: idOrUuid }, banOrUnban ? 'User ${user} banned' : 'User ${user} unbanned');
    } catch (e: any) {
      this.Log.error({ error: e, user: idOrUuid }, 'Error while banning user ${user}');
      process.exitCode = 1;
    }
  }
}
