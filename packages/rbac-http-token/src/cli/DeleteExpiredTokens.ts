import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command } from '@spinajs/cli';

import { deleteExpiredTokens } from '../actions.js';

/**
 * Intended for cyclic execution from a worker process
 * ( eg. cron / task scheduler ) to keep the token table clean.
 */
@Command('rbac:token-delete-expired', 'Deletes all expired access tokens')
export class DeleteExpiredTokens extends CliCommand {
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
