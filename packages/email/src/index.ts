import { InvalidOperation } from '@spinajs/exceptions';
import { DI, AsyncModule, Bootstrapper, Injectable, Autoinject } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Email, EmailSender, EmailConfiguration } from './interfaces';
import { Config } from '@spinajs/configuration';
import CONFIGURATION_SCHEMA from './schemas/email.smtp.configuration';
import { QueueClient } from '@spinajs/queue';

export * from './interfaces';

@Injectable(Bootstrapper)
export class LogBotstrapper extends Bootstrapper {
  public bootstrap(): void {
    DI.register(CONFIGURATION_SCHEMA).asValue('__configurationSchema__');
  }
}

/**
 * Inject INTL module for language support. We does nothing but to initialize module for use in templates.
 */
export class Emails extends AsyncModule {
  @Logger('email')
  protected Log: Log;

  protected Senders: Map<string, EmailSender> = new Map<string, EmailSender>();

  @Config('email')
  protected Configuration: EmailConfiguration;

  @Autoinject(QueueClient)
  protected Queue: QueueClient;

  public async resolveAsync(): Promise<void> {
    for (const c of this.Configuration.connections) {
      this.Log.trace(`Found connection ${c.name} ${c.login}@${c.host}`);

      const connection = (await DI.resolve)<EmailSender>(c.sender, [c]);
      this.Senders.set(c.name, connection);

      this.Log.trace(`Connection initialized - ${c.name} ${c.login}@${c.host}`);
    }

    await super.resolveAsync();
  }

  /**
   *
   * Sends email deferred, it sends email to queue. Proper subscriber should receive and process email in background
   *
   * @param email - email struct
   */
  public async sendDeferred(email: Email) {
    this.Queue.emitJob(email);
  }
 
  /**
   *
   * Tries to sends email immediately
   *
   * @param email - email struct
   */
  public async send(email: Email): Promise<void> {
    if (!this.Senders.has(email.connection)) {
      throw new InvalidOperation(`Email sender ${email.connection} not exists. Please check your configuration files.`);
    }

    const connection = this.Senders.get(email.connection);
    await connection.send(email);
  }
}
