import { QueueService } from '@spinajs/queue';
import { Log, Logger } from '@spinajs/log';
import {  CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { activate, deactivate } from '../actions.js';

// NOTE: this file is an orphaned copy of cli/ActivateUser.ts — it is not in the
// registered `cli` dir and is imported nowhere. Its command id used to collide
// with cli/ActivateUser (`rbac:user-activate`); renamed here to avoid a
// duplicate-command registration if the folder is ever loaded. Consider deleting.
@Command('rbac:user-activate-cron', 'Sets active or inactive user')
export class DeactivatePassowords extends CliCommand {
  @Logger('rbac')
  protected Log: Log;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  public async execute(idOrUuid: string, active: boolean): Promise<void> {
    try {
      await (active ? activate(idOrUuid) : deactivate(idOrUuid));

      this.Log.success(`User ${idOrUuid} ${active ? 'activated' : 'deactivated'}`);
    } catch (e) {
      this.Log.error(`Error while activating user user ${idOrUuid} ${e.message}`);
    }
  }
}
