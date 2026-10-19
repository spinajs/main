import { Injectable, NewInstance } from '@spinajs/di';
import { EmailConnectionOptions, EmailSender } from './interfaces.js';

/**
 * Transport that does nothing.
 *
 * Used for testing, or when we want temporarly disable siding emails
 */
@Injectable(EmailSender)
@NewInstance()
export class BlackHoleEmailTransport extends EmailSender {
  constructor(public Options: EmailConnectionOptions) {
    super();
  }

  public async send(): Promise<void> {}
}
