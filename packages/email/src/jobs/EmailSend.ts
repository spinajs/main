import { QueueJob, Job, ev, IJobFailureContext } from '@spinajs/queue';
import { IEmail, IEmailAttachement, IEmailTemplate } from '../interfaces.js';
import { EmailSendFailed } from '../events/EmailSendFailed.js';
import { emailSend } from '../helpers.js';

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
  public template?: string | IEmailTemplate;
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
    await emailSend(this);
    return {
      result: true,
    };
  }

  public async onFailed(err: unknown, ctx: IJobFailureContext) {
    if (!ctx.isFinal) return;
    await ev(new EmailSendFailed(this, err, ctx));
  }
}
