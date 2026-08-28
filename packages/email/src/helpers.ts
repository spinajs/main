import { EmailService, IEmail } from './interfaces.js';
import { resolve } from '@spinajs/di';
import type { EmailSend } from './jobs/EmailSend.js';

/**
 * Sends immediately email
 */
export async function emailSend(email: IEmail) {
  const srv = await resolve(EmailService);
  return srv.send(email);
}

/**
 * Sends email in background
 */
export async function emailDeferred(email: IEmail): Promise<EmailSend> {
  const srv = await resolve(EmailService);
  return srv.sendDeferred(email);
}
