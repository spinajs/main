import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import { Autoinject, Injectable } from '@spinajs/di';
import { IdentityStore, MfaStep } from '@spinajs/authn/contracts';
import type { IdentityRef, PasskeyCeremony } from '@spinajs/authn/contracts';

import { WebAuthnCredentialStore } from '../contracts.js';
import { WebAuthnChallengeStore } from '../challenge.js';
import type { WebAuthnOptions } from '../options.js';
import { WebAuthnRecoveryCodeStore } from './recovery.js';

/** Left out, a dependency comes from DI; `identities: null` means none. */
export interface WebAuthnMfaStepDeps {
  readonly credentials?: WebAuthnCredentialStore;
  readonly challenges?: WebAuthnChallengeStore;
  readonly recoveryCodes?: WebAuthnRecoveryCodeStore;
  readonly options?: WebAuthnOptions;
  readonly identities?: IdentityStore | null;
}

/**
 * WebAuthn as a second factor. The step's strings are JSON: `beginEnrolment` gives `{ challengeId, options }`
 * (PublicKeyCredentialCreationOptionsJSON), `confirmEnrolment` takes `{ challengeId, response, name? }` and `verify`
 * `{ challengeId, response }` for a challenge from `challenge(id)`. Every credential of the identity counts, passkeys
 * included. Stores public keys only, so it keeps no secret (`storesSecrets` false).
 */
@Injectable(MfaStep)
export class WebAuthnMfaStep extends MfaStep {
  readonly name = 'webauthn';

  @Config('authn.webauthn')
  protected WebAuthnConfig: WebAuthnOptions;

  @Autoinject(WebAuthnCredentialStore, { optional: true })
  protected Credentials: WebAuthnCredentialStore | undefined;

  @Autoinject(WebAuthnChallengeStore, { optional: true })
  protected Challenges: WebAuthnChallengeStore | undefined;

  @Autoinject(WebAuthnRecoveryCodeStore, { optional: true })
  protected RecoveryCodes: WebAuthnRecoveryCodeStore | undefined;

  @Autoinject(IdentityStore, { optional: true })
  protected IdentityStore: IdentityStore | undefined;

  constructor(protected readonly given: WebAuthnMfaStepDeps = {}) {
    super();
  }

  enrolled(_id: IdentityRef): Promise<boolean> {
    throw new Error('not implemented: WebAuthnMfaStep.enrolled');
  }

  beginEnrolment(_id: IdentityRef): Promise<{ provisioning: string }> {
    throw new Error('not implemented: WebAuthnMfaStep.beginEnrolment');
  }

  confirmEnrolment(_id: IdentityRef, _response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    throw new Error('not implemented: WebAuthnMfaStep.confirmEnrolment');
  }

  /** Assertion options for the identity's own credentials, for `verify`. */
  challenge(_id: IdentityRef): Promise<PasskeyCeremony> {
    throw new Error('not implemented: WebAuthnMfaStep.challenge');
  }

  verify(_id: IdentityRef, _response: string): Promise<boolean> {
    throw new Error('not implemented: WebAuthnMfaStep.verify');
  }

  verifyRecovery(_id: IdentityRef, _code: string): Promise<boolean> {
    throw new Error('not implemented: WebAuthnMfaStep.verifyRecovery');
  }

  regenerateRecoveryCodes(_id: IdentityRef): Promise<readonly string[]> {
    throw new Error('not implemented: WebAuthnMfaStep.regenerateRecoveryCodes');
  }

  disable(_id: IdentityRef): Promise<void> {
    throw new Error('not implemented: WebAuthnMfaStep.disable');
  }
}
