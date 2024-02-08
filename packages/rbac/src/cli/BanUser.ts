import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Commands } from '../models/User.js';

@Command('rbac:user-ban', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('ban', ' true / false', false, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
@Argument('duration', 'how long should ban last ( in minutes )', 24 * 60, (opt: string) => parseInt(opt))
@Argument('reason', 'reason for ban')
export class BanUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, ban: boolean, duration: number, reason: string): Promise<void> {
    try {
      if (ban) {
        await Commands.ban(idOrUuid, reason, duration);
      } else {
        await Commands.unban(idOrUuid);
      }

      this.Log.success(`User ${idOrUuid} ${ban ? 'banned' : 'unbanned'}`);
    } catch (e) {
      this.Log.error(`Error while banning user ${idOrUuid} ${e.message}`);
    }
  }
}
