import type { IdentityRef, SecretStore } from '@spinajs/authn/contracts';

/** The SecretStore purpose of the code; the attempt tickets use `<purpose>-try-<n>`. */
export const EMAIL_CODE_PURPOSE = 'email-code';
export const EMAIL_CODE_DIGITS = 6;
/** Verifies a code survives, right or wrong. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

/** One-time 6-digit codes over a SecretStore. */
export class EmailCodes {
  constructor(protected readonly secrets: SecretStore) {}

  /** Replaces the identity's code and its attempt tickets; the code is returned once. */
  public async issue(_id: IdentityRef, _ttlSeconds: number): Promise<string> {
    throw new Error('not implemented: EmailCodes.issue');
  }

  /** Spends one attempt, then redeems the code. */
  public async verify(_id: IdentityRef, _code: string): Promise<boolean> {
    throw new Error('not implemented: EmailCodes.verify');
  }
}
