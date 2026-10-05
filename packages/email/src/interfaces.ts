import { AsyncService, Autoinject, IMappableService, Injectable, NewInstance, ResolveException } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { QueueService } from '@spinajs/queue';
import { EmailSend } from './jobs/EmailSend.js';
import { fs, getFs } from '@spinajs/fs';
import { attachmentFile } from './attachments.js';

export abstract class EmailSender extends AsyncService implements IMappableService {
  public Options: EmailConnectionOptions;

  @Config('email.templateFs')
  protected defaultTemplateFsName: string;

  protected defaultTemplateFs: fs;

  @Config('fs.defaultProvider')
  protected DefaultFileProvider: string;

  public get ServiceName() {
    return this.Options.name;
  }

  abstract send(email: IEmail): Promise<void>;

  public async resolve() {
    if (this.defaultTemplateFsName) {
      this.defaultTemplateFs = getFs(this.defaultTemplateFsName);

      if (!this.defaultTemplateFs) {
        throw new ResolveException('Default email template filesystem ' + this.defaultTemplateFsName + ' not found. Please check your configuration for email.templateFs and make sure that fs provider with name ' + this.defaultTemplateFsName + ' is registered');
      }
    }
  }
}

@Injectable(EmailSender)
@NewInstance()
export class BlackHoleEmailSender extends EmailSender {
  @Logger('email')
  protected Log: Log;

  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  /** Reads the attachments as a real transport would, so a refused read fails here as it would in production. */
  public async send(email: IEmail): Promise<void> {
    for (const a of email.attachements ?? []) {
      await attachmentFile(a, this.DefaultFileProvider);
    }

    this.Log.info(`Email ${email.subject} sent to black hole`);
  }
}

export interface IEmailAttachement {
  /**
   * - filename to be reported as the name of the attached file. Use of unicode is allowed.
   */
  name: string;

  /**
   * Path to file
   */
  path: string;

  /**
   * File provider could be local fs, aws s3 etc. Default is always fs-local
   */
  provider?: string;

  /**
   * Content-id if provided to embedd image in message
   */
  cid?: string;

  /**
   * The local file the email service already read through the attachment's filesystem. A transport sends it and does
   * not read `path` again. Only the service sets it: it drops a value the caller passed, whatever `email.attachments.check` says.
   */
  file?: string;
}

/**
 * Email template def if template is in different fs than default templateFs
 */
export interface IEmailTemplate {
  /**
   * Template name
   */
  file: string;

  /**
   * Template filesystem to use
   */
  fs: string;
}

export interface IEmail {
  to: string[];

  cc?: string[];

  bcc?: string[];

  /**
   * From email - if not set, default adress from connection configuration is used
   */
  from?: string;

  connection: string;

  attachements?: IEmailAttachement[];

  /**
   * Local template name. Must be avaible in one of dirs set in template config
   */
  template?: string | IEmailTemplate;

  /**
   * Some implementations have predefined templates. It can be accessed by this Id
   * eg. mailersend
   */
  templateId?: string;

  /**
   * Data passed to template
   */
  model?: any;

  /**
   * Text representation of email
   */
  text?: string;

  subject: string;

  lang?: string;

  priority?: string;

  replyTo?: string;

  /**
   * Additional tag for email,
   * usefull for identyfying emails by category or module that sends it
   */
  tag?: string;

  /**
   * Unique email id, for identification eg. in case of delivery failure
   */
  emailId?: string;

  /**
   * Per-email override of the queue-level retry count used when the email is sent deferred.
   * Falls back to `email.retry.count` configuration when not set.
   */
  retryCount?: number;

  /**
   * Secret values that `model` or `text` carries, e.g. a reset token or the link holding it. A mail with any is never queued:
   * `sendDeferred` refuses it, the `EmailSent` event leaves out its model and text, and errors are logged and thrown with each
   * value, raw and URI-encoded, replaced by `[redacted]`.
   */
  redact?: readonly string[];

  /**
   * Email delivery schedule. If we want to repeat email, schedule to send at specific time, send delayed etc..
   */
  schedule?: {
    /**
     * Use a Cron entry to set the schedule
     */
    cron?: string;

    /**
     * The time in milliseconds that a message will wait before being scheduled to be delivered
     */
    delay?: number;

    /**
     * The time in milliseconds to wait after the start time to wait before scheduling the message again
     */
    period?: number;

    /**
     * The number of times to repeat scheduling a message for delivery
     */
    repeat?: number;
  };
}

export interface EmailConfiguration {
  connections: EmailConnectionOptions[];
  defaultConnection: string;

  /**
   * Default queue-level retry policy for deferred emails.
   */
  retry?: {
    /**
     * How many times a deferred email job is retried on failure. Defaults to 3.
     */
    count?: number;
  };

  /**
   * Reset and invite mails sent by `EmailPasswordMailer`.
   */
  password?: PasswordMailConfiguration;

  attachments?: {
    /**
     * Default true: `send` reads every attachment through its filesystem as the sending principal, before the
     * transport. False leaves the reading to the transport (2.x), which reads as whoever runs it.
     */
    check?: boolean;
  };
}

export interface PasswordMailPurposeConfiguration {
  subject?: string;

  /**
   * Without a template the mail is a short plain-text body.
   */
  template?: string | IEmailTemplate;
}

export interface PasswordMailConfiguration {
  /**
   * Defaults to `email.defaultConnection`.
   */
  connection?: string;
  from?: string;
  lang?: string;
  reset?: PasswordMailPurposeConfiguration;
  invite?: PasswordMailPurposeConfiguration;
}

export interface EmailConnectionOptions {
  /**
   * DI service name of the {@link EmailSender} implementation handling this connection.
   * Selected via {@link AutoinjectService} ( reads the `service` key of each connection entry ).
   */
  service: string;
  name: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  ssl?: boolean;

  templates?: {
    // defaults passed to email templates
    defaults?: any;
  };

  /**
   * defaults for messages
   */
  defaults?: {
    /**
     * defalt `from` adress, can be override when sending
     */
    mailFrom?: string;
  };

  /**
   * Replaces every recipient of every email on this connection with these addresses,
   * recording the real ones in the subject. For dev and staging stacks that must exercise
   * the real SMTP path without mailing real people.
   *
   * Refused outright when the app runs as production, decided by `configuration.isProduction`.
   */
  redirectTo?: string[];

  /**
   * In-process SMTP send resilience ( retry / timeout ) applied by transports when
   * talking to the SMTP server, independent of the queue-level job retry.
   */
  resilience?: {
    /**
     * How many times the transport retries a failed SMTP send.
     */
    retries?: number;
    /**
     * Delay ( ms ) between SMTP send retries.
     */
    delay?: number;
    /**
     * Timeout ( ms ) for a single SMTP send attempt.
     */
    timeout?: number;
  };

  /**
   * Additional options passed
   * lib specific
   */
  options?: unknown;
}

export abstract class EmailService extends AsyncService {
  @Logger('email')
  protected Log: Log;

  @AutoinjectService('email.connections', EmailSender)
  protected Senders: Map<string, EmailSender>;

  @Config('email')
  protected Configuration: EmailConfiguration;

  @Autoinject(QueueService)
  protected Queue: QueueService;

  /**
   *
   * Sends email immediatelly ( in current process )
   *
   * @param email - email to send
   */
  public abstract send(email: IEmail): Promise<void>;

  /**
   *
   * Schedules email to send ( adds to queue ). Email is sent by separate process
   * that subscribe for specific events
   *
   * @param email - email to send
   */
  public abstract sendDeferred(email: IEmail): Promise<EmailSend>;

  /**
   * Subscribte to queue for emails to send
   */
  public abstract processDeferredEmails(): Promise<void>;
}
