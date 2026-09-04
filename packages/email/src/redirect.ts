import { IEmail } from './interfaces.js';

/**
 * Recipient redirection is refused outright on production, whatever a connection configures.
 * That decision is NOT made here: it reads `configuration.isProduction`, the framework's single
 * source of truth, which derives from the same value that selects the config files and which an
 * app may override in its own config.
 *
 * This module used to carry its own `isProductionEnv` matcher over `APP_ENV`. Two sources of
 * truth for one question is how they drift - and the local one could not see an app's override.
 */

/** How many original recipients the subject prefix names before it summarises the rest. */
const MAX_LISTED_RECIPIENTS = 3;

/**
 * ASCII rather than a Unicode arrow: subject lines are encoded and re-encoded by mail
 * clients, and an ASCII prefix survives that untouched.
 */
function subjectPrefix(originalTo: string[]): string {
  if (originalTo.length === 0) {
    return '[DEV] ';
  }

  const listed = originalTo.slice(0, MAX_LISTED_RECIPIENTS).join(',');
  const remaining = originalTo.length - MAX_LISTED_RECIPIENTS;

  return remaining > 0 ? `[DEV->${listed} +${remaining} more] ` : `[DEV->${listed}] `;
}

/**
 * Replaces every recipient of `email` with `redirectTo`, recording the real ones in the
 * subject. Returns `null` when no redirect is configured, so the caller can send the
 * original untouched.
 *
 * Returns a COPY. Never mutate the argument: `EmailSend.execute()` runs again on the same
 * job instance when the queue retries, so mutating would stack a second prefix per retry
 * and corrupt the persisted job.
 */
export function redirectRecipients(email: IEmail, redirectTo?: string[]): IEmail | null {
  if (!redirectTo || redirectTo.length === 0) {
    return null;
  }

  return {
    ...email,
    to: [...redirectTo],
    cc: undefined,
    bcc: undefined,
    subject: `${subjectPrefix(email.to ?? [])}${email.subject ?? ''}`,
  };
}
