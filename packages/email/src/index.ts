import { InvalidOperation } from '@spinajs/exceptions';
import { Bootstrapper, Injectable } from '@spinajs/di';
import { Perf } from '@spinajs/log';
import { Config, normalizeEnvironment, registerConfigurationSchema } from '@spinajs/configuration';
import { IEmail, EmailService } from './interfaces.js';
import CONFIGURATION_SCHEMA from './schemas/email.smtp.configuration.js';
import { EmailSent } from './events/EmailSent.js';
import { EmailSend } from './jobs/EmailSend.js';
import { redirectRecipients } from './redirect.js';
import { hasSecrets, redactError } from './redact.js';
import { downloadAttachment } from './attachments.js';

export * from './interfaces.js';
export * from './attachments.js';
export * from './transports.js';
export * from './jobs/EmailSend.js';
export * from './events/EmailSent.js';
export * from './events/EmailSendFailed.js';
export * from './helpers.js';
export * from './fp.js';
export * from './redirect.js';
export * from './redact.js';
export * from './password-mailer.js';

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    registerConfigurationSchema(CONFIGURATION_SCHEMA);
  }
}

/**
 * Email sending service.
 */
@Injectable(EmailService)
export class DefaultEmailService extends EmailService {
  @Config('configuration.isProduction')
  protected IsProductionFlag: boolean | undefined;

  /**
   * `configuration.isProduction`, the framework's answer, which an app's own config may override. Without a boolean
   * (a Configuration that does not load the shipped configuration module) the env decides, as in authz.
   */
  protected get IsProduction(): boolean {
    const flag = this.IsProductionFlag;
    return typeof flag === 'boolean' ? flag : normalizeEnvironment(process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development') === 'prod';
  }

  @Config('email.attachments.check', { defaultValue: true })
  protected CheckAttachments: boolean;

  @Config('fs.defaultProvider')
  protected DefaultFileProvider: string;

  public async resolve(): Promise<void> {
    await super.resolve();

    if (!this.IsProduction) {
      return;
    }

    // Visibility only - send() enforces this independently. Scans the configuration rather
    // than the Senders map because config data is plainly present here, whereas the
    // population order of an @AutoinjectService field relative to resolve() is not
    // guaranteed, and a guard that silently no-ops is worse than no guard.
    for (const c of this.Configuration?.connections ?? []) {
      if (c.redirectTo?.length) {
        this.Log.error(`Email connection ${c.name} configures redirectTo, which is refused on production. Recipients are NOT redirected.`);
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

    // Outside the redaction below: a read error names the attachment's path, not the mail's secrets, and
    // an AccessDenied must keep its class and decision.
    let withFiles: IEmail;
    try {
      withFiles = await this.readAttachments(email);
    } catch (err) {
      this.Log.error(err, `Cannot read attachments of email on connection ${connection}, subject: ${email.subject}, recipients: ${email.to?.length ?? 0}`);
      Perf.count('email.send.failed', 1, { connection });
      throw err;
    }

    // Production never redirects, whatever the connection configures. Enforced here rather
    // than by editing the options at startup so the guarantee does not depend on injection
    // order. No error log on this path: prod mail volume would flood it, and resolve()
    // already reported the misconfiguration once.
    const target = this.IsProduction ? undefined : this.Senders.get(connection)!.Options.redirectTo;
    const redirected = redirectRecipients(withFiles, target);

    if (redirected) {
      this.Log.warn(`Email on connection ${connection} redirected to ${target!.length} configured address(es), ${email.to?.length ?? 0} original recipient(s) replaced`);
      this.Log.trace(`Original recipients on connection ${connection}: ${(email.to ?? []).join(', ')}`);
    }

    // Only the transport sees the redirected copy. Every log line below, and the EmailSent
    // event, keep referencing the caller's original `email` - the redirected subject embeds
    // the real recipients by construction, and those log lines print the subject at INFO/ERROR.
    const outgoing = redirected ?? withFiles;

    // Redacted inside the span: Perf hands a failed span's error to every sink, and the log sink prints it.
    const transport = async () => {
      try {
        await this.Senders.get(connection)!.send(outgoing);
      } catch (err) {
        throw redactError(err, email.redact);
      }
    };

    try {
      await Perf.measure('email.send', transport, { labels: { connection } });
    } catch (err) {
      // full recipient addresses are PII - keep them at trace level only, log just the count otherwise.
      this.Log.error(err, `Cannot send email on connection ${connection}, subject: ${email.subject}, recipients: ${email.to?.length ?? 0}`);
      this.Log.trace(`Failed email recipients on connection ${connection}: ${(email.to ?? []).join(', ')}`);
      Perf.count('email.send.failed', 1, { connection });

      // Rethrow so a queue consumer can retry or dead-letter; for a mail with `redact` this is already the redacted copy.
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

  /**
   * A copy of `email` whose attachments carry the local `file`, each read through its filesystem in the
   * caller's async context, so a guarded filesystem checks `fs:read` as the sending principal. With the check off the
   * copy only drops `file`, so a caller (or a queued payload) cannot hand the transport a local path or URL unread.
   */
  protected async readAttachments(email: IEmail): Promise<IEmail> {
    if (!email.attachements?.length) {
      return email;
    }

    if (!this.CheckAttachments) {
      return { ...email, attachements: email.attachements.map(({ file: _caller, ...a }) => a) };
    }

    const attachements = [];
    for (const a of email.attachements) {
      attachements.push({ ...a, file: await downloadAttachment(a, this.DefaultFileProvider) });
    }

    return { ...email, attachements };
  }

  public async sendDeferred(email: IEmail): Promise<EmailSend> {
    // The job payload sits on the queue and, with a persistent transport, in a table (SR-09).
    if (hasSecrets(email)) {
      throw new InvalidOperation('An email with secret values (redact) cannot be sent deferred, use send()');
    }

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
