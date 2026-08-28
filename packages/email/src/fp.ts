import { IEmail } from './interfaces.js';
import { emailSend, emailDeferred } from './helpers.js';
import type { EmailSend } from './jobs/EmailSend.js';

/**
 * Sends immediately email
 *
 * Kept for compatibility - delegates to the imperative {@link emailSend}.
 */
export async function _emailSend(email: IEmail) {
  return emailSend(email);
}

/**
 * Sends email in background
 *
 * Kept for compatibility - delegates to the imperative {@link emailDeferred}.
 */
export async function _emailDeferred(email: IEmail): Promise<EmailSend> {
  return emailDeferred(email);
}
