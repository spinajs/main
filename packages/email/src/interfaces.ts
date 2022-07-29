export interface EmailRenderer {
  render(template: string, model: unknown): Promise<string>;
}

export interface EmailSender {}

export interface Email {
  mailTo: string[];
  mailFrom: string[];
  connection: string;
  attachements?: string[];
  template?: string;
  model: unknown;
  renderer?: string;
  text: string;
  subject: string;
}

export interface EmailConfiguration {
  connections: EmailConnection[];
  defaultConnection: string;
}

export interface EmailConnection {
  name: string;
  host?: string;
  port?: number;
  login?: string;
  password?: string;

  /**
   * defaults for messages
   */
  defaults?: {
    /**
     * default renderer, can be override when sending
     */
    renderer?: string;

    /**
     * defalt `from` adress, can be override when sending
     */
    mailFrom?: string;
  };

  /**
   * Additional options passed
   */
  options?: unknown;
  attachements: {
    maxSingleSize: number;
    maxTotalSize: number;
    maxCount: number;
  };
}
