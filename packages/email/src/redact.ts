import type { IEmail } from './interfaces.js';

export const REDACTED = '[redacted]';

/** Longest first, so a link is replaced whole before the token inside it. */
function forms(secrets: readonly string[]): string[] {
  const all = new Set<string>();
  for (const s of secrets) {
    if (s) {
      all.add(s);
      all.add(encodeURIComponent(s));
    }
  }
  return [...all].sort((a, b) => b.length - a.length);
}

export function hasSecrets(email: Pick<IEmail, 'redact'>): boolean {
  return email.redact?.some((s) => s.length > 0) ?? false;
}

/** Replaces each secret value, raw and URI-encoded, with {@link REDACTED}. */
export function redactText(text: string, secrets: readonly string[] | undefined): string {
  return secrets ? forms(secrets).reduce((t, s) => t.split(s).join(REDACTED), text) : text;
}

/**
 * `err` itself when there is nothing to redact. Otherwise a new `Error` with the same name and the message redacted, and no
 * cause: the original's stack, cause and own fields (an SMTP response, say) may hold a secret too.
 */
export function redactError<T>(err: T, secrets: readonly string[] | undefined): T | Error {
  if (!secrets || !hasSecrets({ redact: secrets })) {
    return err;
  }
  const e = new Error(redactText(err instanceof Error ? err.message : String(err), secrets));
  e.name = redactText(err instanceof Error ? err.name : 'Error', secrets);
  return e;
}
