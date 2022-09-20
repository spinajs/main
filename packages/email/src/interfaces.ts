import { Message, Serialize } from '@spinajs/queue';
export abstract class EmailSender {
  public Options: EmailConnectionOptions;

  abstract send(email: Email): Promise<void>;
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

export class Email extends Message {
  @Serialize()
  to: string[];

  @Serialize()
  cc?: string[];

  @Serialize()
  bcc?: string[];

  @Serialize()
  from: string;

  @Serialize()
  connection: string;

  @Serialize()
  attachements?: IEmailAttachement[];

  /**
   * Local template name. Must be avaible in one of dirs set in template config
   */
  @Serialize()
  template?: string;

  /**
   * Some implementations have predefined templates. It can be accessed by this Id
   * eg. mailersend
   */
  @Serialize()
  templateId?: string;

  /**
   * Data passed to template
   */
  @Serialize()
  model?: unknown;

  /**
   * Text representation of email
   */
  @Serialize()
  text?: string;

  @Serialize()
  subject: string;

  @Serialize()
  lang?: string;

  @Serialize()
  priority?: string;

  @Serialize()
  replyTo?: string;

  /**
   * Additional tag for email,
   * usefull for identyfying emails by category or module that sends it
   */
  @Serialize()
  tag?: string;

  /**
   * Unique email id, for identification eg. in case of delivery failure
   */
  @Serialize()
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
  login?: string;
  password?: string;
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
