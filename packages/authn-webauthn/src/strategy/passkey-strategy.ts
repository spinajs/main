import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import { Autoinject, Injectable } from '@spinajs/di';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';

import { WebAuthnCredentialStore } from '../contracts.js';
import { WebAuthnChallengeStore } from '../challenge.js';
import type { AssertionVerifier } from '../ceremony.js';
import type { WebAuthnOptions } from '../options.js';

/** Left out, a dependency comes from DI. */
export interface PasskeyStrategyDeps {
  readonly credentials?: WebAuthnCredentialStore;
  readonly challenges?: WebAuthnChallengeStore;
  readonly options?: WebAuthnOptions;
  /** verifyAuthenticationResponse of `@simplewebauthn/server` unless given. */
  readonly verifier?: AssertionVerifier;
}

/**
 * Passkey login: `{ kind: 'webauthn', challengeId, response }` with a login challenge from `PasskeyService.challenge`
 * and the browser's AuthenticationResponseJSON for a discoverable credential. Method 'webauthn'; assurance 'aal2' when
 * the authenticator verified the user, else 'aal1' (D7).
 */
@Injectable(AuthenticationStrategy)
export class PasskeyStrategy extends AuthenticationStrategy {
  readonly name: string = 'passkey';
  readonly kinds: readonly string[] = ['webauthn'];
  readonly interactive = true;

  @Config('authn.webauthn')
  protected WebAuthnConfig: WebAuthnOptions;

  @Autoinject(WebAuthnCredentialStore, { optional: true })
  protected Credentials: WebAuthnCredentialStore | undefined;

  @Autoinject(WebAuthnChallengeStore, { optional: true })
  protected Challenges: WebAuthnChallengeStore | undefined;

  constructor(protected readonly given: PasskeyStrategyDeps = {}) {
    super();
  }

  throttleKeys(_c: Credentials, _ctx: AuthnContext): readonly ThrottleKey[] {
    throw new Error('not implemented: PasskeyStrategy.throttleKeys');
  }

  verify(_c: Credentials, _ctx: AuthnContext): Promise<StrategyOutcome> {
    throw new Error('not implemented: PasskeyStrategy.verify');
  }
}
