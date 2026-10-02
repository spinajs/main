import { Log, Logger } from '@spinajs/log';
import { Command } from '@spinajs/cli';
import { RbacCliCommand } from '@spinajs/rbac';

import { deleteExpiredTokens } from '../actions.js';

/**
 * Intended for cyclic execution from a worker process
 * ( eg. cron / task scheduler ) to keep the token table clean.
 */
@Command('rbac:token-delete-expired', 'Deletes all expired access tokens')
export class DeleteExpiredTokens extends RbacCliCommand {
  @Logger('rbac-http-token')
  protected Log: Log;

  public async execute(): Promise<void> {
    try {
      const count = await deleteExpiredTokens();
      this.Log.success(`Deleted ${count} expired token(s)`);
    } catch (e) {
      this.Log.error(`Error while deleting expired tokens: ${(e as Error).message}`);
    }
  }
}
