import { InvalidOperation } from '@spinajs/exceptions';
import { DI, Bootstrapper, Injectable } from '@spinajs/di';
import { IEmail, EmailService } from './interfaces.js';
import CONFIGURATION_SCHEMA from './schemas/email.smtp.configuration.js';
import { EmailSent } from './events/EmailSent.js';
import { EmailSend } from './jobs/EmailSend.js';

export * from './interfaces.js';
export * from './transports.js';
export * from './jobs/EmailSend.js';

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}

/**
 * Email sending service.
 */
@Injectable(EmailService)
export class DefaultEmailService extends EmailService {
  /**
   *
   * Tries to sends email immediately
   *
   * @param email - email struct
   */
  public async send(email: IEmail): Promise<void> {
    if (!this.Senders.has(email.connection)) {
      throw new InvalidOperation(`Email sender ${email.connection} not exists. Please check your configuration files.`);
    }

    await this.Senders.get(email.connection).send(email);

    // inform others of email event
    await this.Queue.emit(new EmailSent(email));
  }

  public async sendDeferred(email: IEmail): Promise<EmailSend> {
    const dEmail = new EmailSend();
    dEmail.hydrate(email);
    await this.Queue.emit(dEmail);

    return dEmail;
  }

  public async processDefferedEmails(): Promise<void> {
    await this.Queue.consume(EmailSend);
  }
}
