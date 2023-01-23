import { Injectable, NewInstance } from '@spinajs/di';
import { EmailSender } from './interfaces.js';

/**
 * Transport that does nothing.
 *
 * Used for testing, or when we want temporarly disable siding emails
 */
@Injectable()
@NewInstance()
export class BlackHoleEmailTransport extends EmailSender {
  public async send(): Promise<void> {}
}
