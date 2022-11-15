import { AsyncService, Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { QueueService } from '@spinajs/queue';
export abstract class EmailSender extends AsyncService {
  public Options: EmailConnectionOptions;

  abstract send(email: IEmail): Promise<void>;
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
}

export interface IEmail {
  to: string[];

  cc?: string[];

  bcc?: string[];

  from: string;

  connection: string;

  attachements?: IEmailAttachement[];

  /**
   * Local template name. Must be avaible in one of dirs set in template config
   */
  template?: string;

  /**
   * Some implementations have predefined templates. It can be accessed by this Id
   * eg. mailersend
   */
  templateId?: string;

  /**
   * Data passed to template
   */
  model?: unknown;

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
}

export interface EmailConfiguration {
  connections: EmailConnectionOptions[];
  defaultConnection: string;
}

export interface EmailConnectionOptions {
  sender: string;
  name: string;
  host?: string;
  port?: number;
  user?: string;
  pass?: string;
  ssl?: boolean;

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
  public abstract sendDeferred(email: IEmail): Promise<void>;

  /**
   * Subscribte to queue for emails to send
   */
  public abstract processDefferedEmails(): Promise<void>;
}
