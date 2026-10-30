import { DI, Inject, Injectable } from '@spinajs/di';
import { MAILER, SETTINGS } from './tokens.js';
import { SmtpMailer } from './register.js';

@Inject(SmtpMailer)
@Injectable()
export class Sender {
  public async run(): Promise<void> {
    DI.resolve(MAILER);
    await DI.resolve(SETTINGS);
  }
}
