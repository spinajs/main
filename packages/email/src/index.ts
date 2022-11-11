import { InvalidOperation } from '@spinajs/exceptions';
import { DI, AsyncService, Bootstrapper, Injectable, Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { IEmail, EmailSender, EmailConfiguration } from './interfaces';
import { AutoinjectService, Config } from '@spinajs/configuration';
import CONFIGURATION_SCHEMA from './schemas/email.smtp.configuration';
import { QueueService } from '@spinajs/queue';
import { EmailSent } from './events/EmailSent';

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
 * Inject INTL module for language support. We does nothing but to initialize module for use in templates.
 */
export class Emails extends AsyncService {
  @Logger('email')
  protected Log: Log;

  @AutoinjectService('email.connections', EmailSender)
  protected Senders: Map<string, EmailSender>;

  @Config('email')
  protected Configuration: EmailConfiguration;

  @Autoinject(QueueService)
  protected Queue: QueueService;

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
}
