import { Log, Logger } from '@spinajs/log';
import { Command } from '@spinajs/cli';
import { DI } from '@spinajs/di';
import { TokenService } from '@spinajs/authn/contracts';

import { TokenCliCommand } from './TokenCliCommand.js';

interface ExpiredTokenSweeper {
  deleteExpired(now: Date): Promise<number>;
}

const sweepsExpired = (s: unknown): s is ExpiredTokenSweeper => typeof (s as Partial<ExpiredTokenSweeper> | null)?.deleteExpired === 'function';

/** Housekeeping for a scheduler (cron, worker); expired and revoked tokens are already refused on use. */
@Command('authn:token-delete-expired', 'Deletes expired and revoked API tokens')
export class DeleteExpiredTokens extends TokenCliCommand {
  @Logger('authn-token')
  protected Log: Log;

  public async execute(): Promise<void> {
    try {
      const tokens = await DI.resolve(TokenService);
      if (!sweepsExpired(tokens)) {
        throw new Error(`${tokens.constructor.name} cannot delete expired tokens`);
      }

      const count = await tokens.deleteExpired(new Date());
      this.Log.success(`Deleted ${count} expired or revoked token(s)`);
    } catch (e) {
      this.Log.error(`Error while deleting expired tokens: ${(e as Error).message}`);
    }
  }
}
