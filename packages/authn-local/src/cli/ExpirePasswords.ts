import { Autoinject, Container } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Command } from '@spinajs/cli';

import { PasswordExpirationJob } from '../expiration.js';
import { LocalCliCommand } from './LocalCliCommand.js';

/** For a scheduler (cron, task scheduler): authn-local runs no timer of its own (D16). */
@Command('authn:password-expire', 'Expires passwords older than authn.local.expiration.maxAgeDays')
export class ExpirePasswords extends LocalCliCommand {
  @Logger('authn-local')
  protected Log: Log;

  @Autoinject(Container)
  protected Container: IContainer;

  public async execute(): Promise<void> {
    // Per call: the CLI boots only this command, so `--help` must not build services that can fail on a bad policy.
    const job = await this.Container.resolve(PasswordExpirationJob);
    const result = await job.run();
    if (result.idle === 'disabled') {
      this.Log.info('Password expiry is disabled (authn.local.expiration.enabled)');
    } else if (result.idle === 'no_source') {
      this.Log.warn('No PasswordAgeSource is registered; nothing was expired');
    } else {
      this.Log.success({ expired: result.expired, skipped: result.skipped, failed: result.failed }, 'Passwords expired: ${expired}, already expired: ${skipped}, failed: ${failed}');
    }
  }
}
