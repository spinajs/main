import { Autoinject, Injectable } from '@spinajs/di';
import { IdentityStore, MfaEnrolmentMarks, MfaStep, PasswordService, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnContext, IdentityRef } from '@spinajs/authn/contracts';

export const EMAIL_CODE_STEP = 'email-code';

/** Left out, a dependency comes from DI. */
export interface EmailCodeMfaStepDeps {
  readonly secrets: SecretStore;
  readonly identities: IdentityStore;
  readonly marks: MfaEnrolmentMarks;
  readonly passwords: PasswordService;
}

/** A second factor by a code mailed to the verified address (A36). */
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

  constructor(protected readonly Deps?: EmailCodeMfaStepDeps) {
    super();
  }

  public async enrolled(_id: IdentityRef): Promise<boolean> {
    throw new Error('not implemented: EmailCodeMfaStep.enrolled');
  }

  public async beginEnrolment(_id: IdentityRef): Promise<{ provisioning: string }> {
    throw new Error('not implemented: EmailCodeMfaStep.beginEnrolment');
  }

  public async confirmEnrolment(_id: IdentityRef, _response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    throw new Error('not implemented: EmailCodeMfaStep.confirmEnrolment');
  }

  public async verify(_id: IdentityRef, _response: string): Promise<boolean> {
    throw new Error('not implemented: EmailCodeMfaStep.verify');
  }

  public async challenge(_id: IdentityRef, _ctx: AuthnContext): Promise<void> {
    throw new Error('not implemented: EmailCodeMfaStep.challenge');
  }

  public async disable(_id: IdentityRef): Promise<void> {
    throw new Error('not implemented: EmailCodeMfaStep.disable');
  }
}
