import { IEmail } from './interfaces.js';

/**
 * Environments where recipient redirection is refused outright, whatever a connection
 * configures. Compared against the value `@spinajs/configuration` resolves into
 * `process.env.APP_ENV` — the same value it uses to choose which config file loads, so the
 * guard and the loaded configuration cannot disagree.
 *
 * `prod` is here as well as `production` because `configuration.isProduction` is
 * `NODE_ENV === 'production'` exactly, and a stack running `NODE_ENV=prod` reports false there.
 */
const PRODUCTION_ENVS = ['production', 'prod'];

export function isProductionEnv(env: string | undefined): boolean {
  return PRODUCTION_ENVS.includes((env ?? '').trim().toLowerCase());
}

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
