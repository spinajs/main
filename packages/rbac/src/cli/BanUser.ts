import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { ban, unban } from '../actions.js';

@Command('rbac:user-ban', 'Sets active or inactive user')
@Argument('idOrUuid', true, 'numeric id or uuid')
@Argument('ban', false, ' true / false', (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
@Argument('duration', true, 'how long should ban last ( in minutes )', 24 * 60, (opt: string) => parseInt(opt))
@Argument('reason', true, 'reason for ban')
export class BanUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  public async execute(idOrUuid: string, banOrUnban: boolean, duration: number, reason: string): Promise<void> {
    try {
      (await banOrUnban) ? ban(idOrUuid, reason, duration) : unban(idOrUuid);

      this.Log.success(`User ${idOrUuid} ${ban ? 'banned' : 'unbanned'}`);
    } catch (e) {
      this.Log.error(`Error while banning user ${idOrUuid} ${e.message}`);
    }
  }
}
