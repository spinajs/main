import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command } from '@spinajs/cli';
import { Autoinject } from '@spinajs/di';
import { TokenService } from '@spinajs/authn/contracts';
import { InvalidOperation } from '@spinajs/exceptions';

interface ExpiredTokenSweeper {
  deleteExpired(now: Date): Promise<number>;
}

const sweepsExpired = (s: unknown): s is ExpiredTokenSweeper => typeof (s as Partial<ExpiredTokenSweeper> | null)?.deleteExpired === 'function';

/** Housekeeping for a scheduler (cron, worker); expired and revoked tokens are already refused on use. */
@Command('authn:token-delete-expired', 'Deletes expired and revoked API tokens')
export class DeleteExpiredTokens extends CliCommand {
  @Logger('authn-token')
  protected Log: Log;

  @Autoinject(TokenService)
  protected Tokens: TokenService;

  public async execute(): Promise<void> {
    try {
      const tokens = this.Tokens;
      if (!sweepsExpired(tokens)) {
        throw new InvalidOperation(`${tokens.constructor.name} cannot delete expired tokens`);
      }

      const count = await tokens.deleteExpired(new Date());
      this.Log.success({ count }, 'Deleted ${count} expired or revoked token(s)');
    } catch (e) {
      this.Log.error({ error: e }, 'Error while deleting expired tokens');
      process.exitCode = 1;
    }
  }
}
