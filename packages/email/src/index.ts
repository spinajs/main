import { InvalidOperation } from '@spinajs/exceptions';
import { DI, Bootstrapper, Injectable } from '@spinajs/di';
import { IEmail, EmailService } from './interfaces';
import CONFIGURATION_SCHEMA from './schemas/email.smtp.configuration';
import { EmailSent } from './events/EmailSent';
import { EmailSend } from './jobs/EmailSend';

export * from './interfaces';
export * from './transports';
export * from './jobs/EmailSend';

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}

/**
 * Email sending service.
 */
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

  public async sendDeferred(email: IEmail): Promise<void> {
    const dEmail = new EmailSend();
    dEmail.hydrate(email);
    await this.Queue.emit(dEmail);
  }

  public async processDefferedEmails(): Promise<void> {
    await this.Queue.consume(EmailSend);
  }
}
