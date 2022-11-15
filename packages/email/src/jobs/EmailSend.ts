import { DI } from '@spinajs/di';
import { QueueJob, Job } from '@spinajs/queue';
import { EmailService, IEmail, IEmailAttachement } from '../interfaces';

/**
 * Job for sending emails in background
 */
@Job()
export class EmailSend extends QueueJob implements IEmail {
  public to: string[];
  public cc?: string[];
  public bcc?: string[];
  public from: string;
  public connection: string;
  public attachements?: IEmailAttachement[];
  public template?: string;
  public templateId?: string;
  public model?: unknown;
  public text?: string;
  public subject: string;
  public lang?: string;
  public priority?: string;
  public replyTo?: string;
  public tag?: string;
  public emailId?: string;

  public async execute() {
    const emails = await DI.resolve(EmailService);
    await emails.send(this);
  }
}
