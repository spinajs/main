import { InvalidOperation } from '@spinajs/exceptions';
import { DI, Bootstrapper, Injectable } from '@spinajs/di';
import { Perf } from '@spinajs/log';
import { Config } from '@spinajs/configuration';
import { IEmail, EmailService } from './interfaces.js';
import CONFIGURATION_SCHEMA from './schemas/email.smtp.configuration.js';
import { EmailSent } from './events/EmailSent.js';
import { EmailSend } from './jobs/EmailSend.js';
import { isProductionEnv, redirectRecipients } from './redirect.js';

export * from './interfaces.js';
export * from './transports.js';
export * from './jobs/EmailSend.js';
export * from './events/EmailSent.js';
export * from './events/EmailSendFailed.js';
export * from './helpers.js';
export * from './fp.js';
export * from './redirect.js';

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}

/**
 * Email sending service.
 */
@Injectable(EmailService)
export class DefaultEmailService extends EmailService {
  /**
   * The environment configuration resolved — `Env ?? APP_ENV ?? NODE_ENV ?? 'development'`.
   * The same value that chose which config file loaded, so this guard and the loaded
   * configuration cannot disagree.
   */
  @Config('process.env.APP_ENV')
  protected AppEnv: string;

  public async resolve(): Promise<void> {
    await super.resolve();

    if (!isProductionEnv(this.AppEnv)) {
      return;
    }

    // Visibility only - send() enforces this independently. Scans the configuration rather
    // than the Senders map because config data is plainly present here, whereas the
    // population order of an @AutoinjectService field relative to resolve() is not
    // guaranteed, and a guard that silently no-ops is worse than no guard.
    for (const c of this.Configuration?.connections ?? []) {
      if (c.redirectTo?.length) {
        this.Log.error(`Email connection ${c.name} configures redirectTo, which is refused on APP_ENV=${this.AppEnv}. Recipients are NOT redirected.`);
      }
    }
  }

  /**
   *
   * Tries to sends email immediately
   *
   * @param email - email struct
   */
  public async send(email: IEmail): Promise<void> {
    const connection = email.connection;

    if (!this.Senders.has(connection)) {
      this.Log.error(`Email sender ${connection} not exists. Please check your configuration files.`);
      Perf.count('email.send.failed', 1, { connection });
      throw new InvalidOperation(`Email sender ${connection} not exists. Please check your configuration files.`);
    }

    // Production never redirects, whatever the connection configures. Enforced here rather
    // than by editing the options at startup so the guarantee does not depend on injection
    // order. No error log on this path: prod mail volume would flood it, and resolve()
    // already reported the misconfiguration once.
    const target = isProductionEnv(this.AppEnv) ? undefined : this.Senders.get(connection)!.Options.redirectTo;
    const redirected = redirectRecipients(email, target);

    if (redirected) {
      this.Log.warn(`Email on connection ${connection} redirected to ${target!.length} configured address(es), ${email.to?.length ?? 0} original recipient(s) replaced`);
      this.Log.trace(`Original recipients on connection ${connection}: ${(email.to ?? []).join(', ')}`);
      email = redirected;
    }

    try {
      await Perf.measure('email.send', () => this.Senders.get(connection)!.send(email), { labels: { connection } });
    } catch (err) {
      // full recipient addresses are PII - keep them at trace level only, log just the count otherwise.
      this.Log.error(err, `Cannot send email on connection ${connection}, subject: ${email.subject}, recipients: ${email.to?.length ?? 0}`);
      this.Log.trace(`Failed email recipients on connection ${connection}: ${(email.to ?? []).join(', ')}`);
      Perf.count('email.send.failed', 1, { connection });

      // rethrow the ORIGINAL error so the queue consumer sees the failure and can retry / dead-letter.
      throw err;
    }

    Perf.count('email.sent', 1, { connection });
    this.Log.info(`Email sent on connection ${connection}, subject: ${email.subject}, recipients: ${email.to?.length ?? 0}`);

    // inform others of email event. Guard separately: rethrowing after a successful SMTP send
    // would make the queue retry the job and send a DUPLICATE email.
    try {
      await this.Queue.emit(new EmailSent(email));
    } catch (err) {
      this.Log.error(err, `Failed to emit EmailSent event on connection ${connection}, subject: ${email.subject}`);
    }
  }

  public async sendDeferred(email: IEmail): Promise<EmailSend> {
    const dEmail = new EmailSend();
    dEmail.hydrate(email);

    // queue-level retry: per-email override wins, then config default, then 3.
    dEmail.RetryCount = email.retryCount ?? this.Configuration.retry?.count ?? 3;

    /** set queue schedule */
    if (email.schedule) {
      dEmail.ScheduleCron = email.schedule.cron;
      dEmail.ScheduleDelay = email.schedule.delay;
      dEmail.SchedulePeriod = email.schedule.period;
      dEmail.ScheduleRepeat = email.schedule.repeat;
    }

    await this.Queue.emit(dEmail);

    return dEmail;
  }

  public async processDeferredEmails(): Promise<void> {
    await this.Queue.consume(EmailSend);
  }
}
