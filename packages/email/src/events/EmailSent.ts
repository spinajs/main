import { QueueEvent, Event } from '@spinajs/queue';
import { DateTime } from 'luxon';
import { IEmail } from '../interfaces';

@Event()
export class EmailSent extends QueueEvent {
  public Connection?: string;

  public From: string;

  public To: string[];

  /**
   * Email template eg. pug file or mustashe
   */
  public Template?: string;

  /**
   * Data model used in template
   */
  public Model?: any;

  public Subject: string;

  /**
   * text content if template is not provided
   */
  public Content?: string;

  public SentAt: DateTime;

  constructor(email: IEmail) {
    super();

    this.Connection = email.connection;
    this.From = email.from;
    this.To = email.to;
    this.Template = email.template;
    this.Model = email.model;
    this.Subject = email.subject;
    this.Content = email.text;

    this.SentAt = DateTime.now();
  }
}
