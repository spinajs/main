import { DI } from '@spinajs/di';
import { QueueJob, Job } from '@spinajs/queue';
import { Emails } from '..';

/**
 * Job for sending emails in background
 */
@Job()
export class EmailSend extends QueueJob {
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

  public async execute() {
    const emails = await DI.resolve(Emails);

    await emails.send({
      from: this.From,
      to: this.To,
      connection: this.Connection,
      template: this.Template,
      model: this.Model,
      subject: this.Subject,
      text: this.Options,
    });
  }
}
