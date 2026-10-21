import { randomInt, randomUUID } from 'node:crypto';
import { InvalidOperation } from '@spinajs/exceptions';
import type { IdentityRef, SecretStore } from '@spinajs/authn/contracts';

/** The SecretStore purpose of the code; the attempt tickets use `<purpose>-try-<n>`. */
export const EMAIL_CODE_PURPOSE = 'email-code';
export const EMAIL_CODE_DIGITS = 6;
/** Verifies a code survives, right or wrong. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

const FORMAT = new RegExp(`^\\d{${EMAIL_CODE_DIGITS}}$`);
const TICKET = 'try';
const ticketPurpose = (n: number) => `${EMAIL_CODE_PURPOSE}-try-${n}`;
const throwaway = (): IdentityRef => ({ type: 'user', id: randomUUID() });

/**
 * One-time 6-digit codes over a SecretStore: the code is a single-use secret of purpose `email-code`, and the attempts left
 * are single-use tickets of their own, so the limit holds across processes without a counter. A SecretStore that cannot
 * store a chosen value is refused: a random secret would never match a code the user types.
 */
export class EmailCodes {
  constructor(private readonly secrets: SecretStore) {}

  /** Replaces the identity's code and its tickets. The code goes in last, so it never exists without its tickets. */
  public async issue(id: IdentityRef, ttlSeconds: number): Promise<string> {
    const code = String(randomInt(0, 10 ** EMAIL_CODE_DIGITS)).padStart(EMAIL_CODE_DIGITS, '0');
    for (let n = 1; n <= EMAIL_CODE_MAX_ATTEMPTS; n++) {
      await this.store(id, ticketPurpose(n), ttlSeconds, TICKET);
    }
    await this.store(id, EMAIL_CODE_PURPOSE, ttlSeconds, code);
    return code;
  }

  /**
   * Spends one attempt, then redeems the code. Always the same number of redeems, on throwaway identities where no real one is
   * due, so the time tells neither an unknown identity nor a spent code from a live one.
   */
  public async verify(id: IdentityRef, code: string): Promise<boolean> {
    const wellFormed = typeof code === 'string' && FORMAT.test(code);
    let attempt = false;
    for (let n = 1; n <= EMAIL_CODE_MAX_ATTEMPTS; n++) {
      const spent = await this.secrets.redeem(wellFormed && !attempt ? id : throwaway(), ticketPurpose(n), TICKET);
      attempt ||= spent;
    }
    return this.secrets.redeem(attempt ? id : throwaway(), EMAIL_CODE_PURPOSE, wellFormed ? code : '');
  }

  private async store(id: IdentityRef, purpose: string, ttlSeconds: number, value: string): Promise<void> {
    if ((await this.secrets.issue(id, purpose, ttlSeconds, value)) !== value) {
      throw new InvalidOperation('The SecretStore does not keep a chosen secret value, which the email code needs');
    }
  }
}
