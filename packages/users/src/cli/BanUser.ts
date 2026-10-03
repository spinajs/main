import { Log, Logger } from '@spinajs/log';
import { Argument, Command } from '@spinajs/cli';
import { RbacCliCommand } from './RbacCliCommand.js';
import { ban, unban } from '../actions.js';

@Command('rbac:user-ban', 'Bans or unbans user')
@Argument('idOrUuid', true, 'numeric id or uuid')
@Argument('ban', false, ' true / false', (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
@Argument('duration', true, 'how long should ban last ( in minutes )', 24 * 60, (opt: string) => parseInt(opt))
@Argument('reason', true, 'reason for ban')
export class BanUser extends RbacCliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, banOrUnban: boolean, duration: number, reason: string): Promise<void> {
    try {
      await (banOrUnban ? ban(idOrUuid, reason, duration) : unban(idOrUuid));

      this.Log.success(`User ${idOrUuid} ${banOrUnban ? 'banned' : 'unbanned'}`);
    } catch (e: any) {
      this.Log.error(`Error while banning user ${idOrUuid} ${e.message}`);
    }
  }
}
