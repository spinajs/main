import { QueueService } from '@spinajs/Queue';
import { Log, Logger } from '@spinajs/log';
import { Argument, CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { Commands } from '../models/User.js';

@Command('rbac:user-activate', 'Sets active or inactive user')
@Argument('idOrUuid', 'numeric id or uuid')
@Argument('active', ' true / false', false, (opt: string) => (opt.toLowerCase() === 'true' ? true : false))
export class ActivateUser extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  public async execute(idOrUuid: string, active: boolean): Promise<void> {
    try {
      if (active) {
        await Commands.activate(idOrUuid);
      } else {
        await Commands.unban(idOrUuid);
      }
      this.Log.success(`User ${idOrUuid} ${active ? 'activated' : 'deactivated'}`);
    } catch (e) {
      this.Log.error(`Error while activating user user ${idOrUuid} ${e.message}`);
    }
  }
}
