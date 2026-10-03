import { DI } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { CliCommand, Command } from '@spinajs/cli';

import { PasswordExpirationJob } from '../expiration.js';

/** For a scheduler (cron, task scheduler): authn-local runs no timer of its own (D16). */
@Command('authn:password-expire', 'Expires passwords older than authn.local.expiration.maxAgeDays')
export class ExpirePasswords extends CliCommand {
  @Logger('authn-local')
  protected Log: Log;

  public async execute(): Promise<void> {
    const job = await DI.resolve(PasswordExpirationJob);
    const result = await job.run();
    if (result.idle === 'disabled') {
      this.Log.info('Password expiry is disabled (authn.local.expiration.enabled)');
    } else if (result.idle === 'no_source') {
      this.Log.warn('No PasswordAgeSource is registered; nothing was expired');
    } else {
      this.Log.success(`Passwords expired: ${result.expired}, already expired: ${result.skipped}, failed: ${result.failed}`);
    }
  }
}
