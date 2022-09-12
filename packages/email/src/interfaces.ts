export abstract class EmailSender {
  public Options: EmailConnectionOptions;

  abstract send(email: Email): Promise<void>;
}

export interface EmailAttachement {
  /**
   * - filename to be reported as the name of the attached file. Use of unicode is allowed.
   */
  name: string;

  /**
   * Path to file
   */
  path: string;

  /**
   * File provider could be local fs, aws s3 etc.
   */
  provider?: string;
}

export interface Email {
  to: string[];
  cc?: string[];
  bcc?: string[];
  from: string;
  connection: string;
  attachements?: string[];
  template?: string;
  model?: unknown;
  text?: string;
  subject: string;
  asHtml?: boolean;
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
  attachements: {
    maxSingleSize: number;
    maxTotalSize: number;
    maxCount: number;
  };
}
