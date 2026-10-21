import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { IdentityStore, MfaEnrolmentMarks, MfaStep, PasswordService, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnContext, CodeRequestResult, IdentityRef } from '@spinajs/authn/contracts';

import { EmailCodes } from './codes.js';
import { EmailCodeAddressUnverified, EmailCodeAlreadyEnrolled, EmailCodeInvalid, EmailCodeThrottled } from './errors.js';

export const EMAIL_CODE_STEP = 'email-code';

/** Left out, a dependency comes from DI. */
export interface EmailCodeMfaStepDeps {
  readonly secrets: SecretStore;
  readonly identities: IdentityStore;
  readonly marks: MfaEnrolmentMarks;
  readonly passwords: PasswordService;
}

/** `a***@example.com`: enough to recognise the mailbox, nothing to look up. */
function masked(email: string): string {
  const at = email.lastIndexOf('@');
  return at <= 0 ? '***' : `${email[0]}***${email.slice(at)}`;
}

/**
 * A second factor by a code mailed to the verified address (A36). Login asks for it like any step; `challenge` mails the code
 * (POST /auth/mfa/challenge). Nothing secret is stored: enrolment is a mark per identity (`MfaEnrolmentMarks`), the code and
 * its attempts live in the SecretStore. There are no recovery codes: the mailbox is the recovery.
 */
@Injectable(MfaStep)
export class EmailCodeMfaStep extends MfaStep {
  readonly name = EMAIL_CODE_STEP;

  @Autoinject(SecretStore)
  protected Secrets: SecretStore;

  @Autoinject(IdentityStore)
  protected Identities: IdentityStore;

  @Autoinject(MfaEnrolmentMarks)
  protected Marks: MfaEnrolmentMarks;

  @Autoinject(PasswordService)
  protected Passwords: PasswordService;

  private _codes?: EmailCodes;

  constructor(protected readonly Deps?: EmailCodeMfaStepDeps) {
    super();
  }

  public enrolled(id: IdentityRef): Promise<boolean> {
    return this.marks().has(id, this.name);
  }

  /** Throws `EmailCodeAlreadyEnrolled`, `EmailCodeAddressUnverified` (the store must report the address verified) or `EmailCodeThrottled`. */
  public async beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }> {
    if (await this.enrolled(id)) {
      throw new EmailCodeAlreadyEnrolled('The email code is already enrolled for this identity; disable it first');
    }
    const identities = this.identities();
    const email = (await identities.display(id)).email;
    if (!email || (await identities.status(id)).addressVerified !== true) {
      throw new EmailCodeAddressUnverified('The email code needs a verified email address');
    }
    const sent = await this.request(id, { now: new Date(), purpose: 'request' });
    if (sent.status === 'throttled') {
      throw new EmailCodeThrottled('Too many codes were requested; try again later', sent.retryAfterSeconds);
    }
    return { provisioning: masked(email) };
  }

  /** Throws `EmailCodeInvalid` for a wrong, spent or missing code and `EmailCodeAlreadyEnrolled` when another confirmation won. */
  public async confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    if (await this.enrolled(id)) {
      throw new EmailCodeAlreadyEnrolled('The email code is already enrolled for this identity');
    }
    if (!(await this.codes().verify(id, response))) {
      throw new EmailCodeInvalid('The code does not match');
    }
    if (!(await this.marks().mark(id, this.name))) {
      throw new EmailCodeAlreadyEnrolled('The email code is already enrolled for this identity');
    }
    return {};
  }

  public async verify(id: IdentityRef, response: string): Promise<boolean> {
    return (await this.enrolled(id)) && (await this.codes().verify(id, response));
  }

  /** Mails a code to an enrolled identity; a throttled or unenrolled request sends nothing and says nothing. */
  public async challenge(id: IdentityRef, ctx: AuthnContext): Promise<void> {
    if (await this.enrolled(id)) {
      await this.request(id, ctx);
    }
  }

  public async disable(id: IdentityRef): Promise<void> {
    await this.marks().unmark(id, this.name);
  }

  private async request(id: IdentityRef, ctx: AuthnContext): Promise<CodeRequestResult> {
    const passwords = this.Deps ? this.Deps.passwords : this.Passwords;
    if (typeof passwords.challengeCode !== 'function') {
      throw new InvalidOperation('The email code step needs a PasswordService that sends codes (@spinajs/authn-local)');
    }
    return passwords.challengeCode(id, ctx);
  }

  private codes(): EmailCodes {
    return (this._codes ??= new EmailCodes(this.Deps ? this.Deps.secrets : this.Secrets));
  }

  private identities(): IdentityStore {
    return this.Deps ? this.Deps.identities : this.Identities;
  }

  private marks(): MfaEnrolmentMarks {
    return this.Deps ? this.Deps.marks : this.Marks;
  }
}
