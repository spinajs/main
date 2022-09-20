import { Autoinject } from '@spinajs/di';
import { EventBase } from '@spinajs/queue';
import { Email, Emails } from '..';

export class EmailEvent extends EventBase<Email> {
  @Autoinject(Emails)
  protected EmailSrvc: Emails;

  public get Channels(): string[] {
    return ['email:send'];
  }
  public async execute(message: Email) {
    await this.EmailSrvc.send(message);
  }
}
