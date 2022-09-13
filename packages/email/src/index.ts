import { InvalidOperation } from './../../exceptions/src/index';
import { DI, AsyncModule } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { Email, EmailSender, EmailConfiguration } from './interfaces';
import { Config } from '@spinajs/configuration';
export * from './interfaces';

/**
 * Inject INTL module for language support. We does nothing but to initialize module for use in templates.
 */
export class Emails extends AsyncModule {
  @Logger('email')
  protected Log: Log;

  protected Senders: Map<string, EmailSender> = new Map<string, EmailSender>();

  @Config('email')
  protected Configuration: EmailConfiguration;

  public async resolveAsync(): Promise<void> {
    for (const c of this.Configuration.connections) {
      this.Log.trace(`Found connection ${c.name} ${c.login}@${c.host}`);

      const connection = (await DI.resolve)<EmailSender>(c.sender, [c]);
      this.Senders.set(c.name, connection);

      this.Log.trace(`Connection initialized - ${c.name} ${c.login}@${c.host}`);
    }

    await super.resolveAsync();
  }

  public async send(email: Email): Promise<void> {
    if (!this.Senders.has(email.connection)) {
      throw new InvalidOperation(`Email sender ${email.connection} not exists. Please check your configuration files.`);
    }

    const connection = this.Senders.get(email.connection);
    await connection.send(email);
  }
}
