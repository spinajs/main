import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { AuthenticationStrategy } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { isPlainObject } from '@spinajs/util';

import { WebAuthnCredentialStore } from '../contracts.js';
import { WebAuthnChallengeStore, takeChallenge } from '../challenge.js';
import { assertionJson, verifiedAssertion } from '../ceremony.js';
import type { AssertionVerifier } from '../ceremony.js';
import { assertWebAuthnOptions } from '../options.js';
import type { WebAuthnOptions } from '../options.js';

/** Left out, a dependency comes from DI. */
export interface PasskeyStrategyDeps {
  readonly credentials?: WebAuthnCredentialStore;
  readonly challenges?: WebAuthnChallengeStore;
  readonly options?: WebAuthnOptions;
  /** verifyAuthenticationResponse of `@simplewebauthn/server` unless given. */
  readonly verifier?: AssertionVerifier;
}

const FAILED: StrategyOutcome = Object.freeze({ ok: false, reason: 'invalid_credentials' });

/** The assertion of `{ kind: 'webauthn', challengeId, response }`, or null. */
function passkeyCredentials(c: Credentials): { challengeId: string; assertion: NonNullable<ReturnType<typeof assertionJson>> } | null {
  if (!isPlainObject(c) || c.kind !== 'webauthn' || typeof c.challengeId !== 'string') return null;
  const assertion = assertionJson(c.response);
  return assertion ? { challengeId: c.challengeId, assertion } : null;
}

/**
 * Passkey login: `{ kind: 'webauthn', challengeId, response }` with a login challenge from `PasskeyService.challenge`
 * and the browser's AuthenticationResponseJSON for a discoverable credential. Method 'webauthn'; assurance 'aal2' when
 * the authenticator verified the user, else 'aal1' (D7).
 *
 * The challenge is used up before the credential is looked up, and an unknown credential is checked against a key
 * nobody holds, so both answers cost the same (A02). The signature counter must grow past the stored one, unless both
 * stay 0, and moves by compare-and-set, so a replayed or cloned assertion fails.
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

  /** The credential id is the account: a guess at someone's passkey counts against it, as a password does against its login. */
  throttleKeys(c: Credentials, _ctx: AuthnContext): readonly ThrottleKey[] {
    const p = passkeyCredentials(c);
    return p ? [{ kind: 'account', value: `webauthn:${p.assertion.id}` }] : [];
  }

  async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    const credentials = this.given.credentials ?? this.Credentials;
    const challenges = this.given.challenges ?? this.Challenges;
    if (!credentials || !challenges) throw new InvalidOperation('PasskeyStrategy: no WebAuthnCredentialStore or WebAuthnChallengeStore is registered; import "@spinajs/authn-webauthn/db" or register both');
    const options = assertWebAuthnOptions(this.given.options ?? this.WebAuthnConfig);
    const p = passkeyCredentials(c);
    if (!p) return FAILED;
    const challenge = await takeChallenge(challenges, p.challengeId, 'login', ctx.now);
    if (!challenge) return FAILED;
    const stored = await credentials.get(p.assertion.id);
    const ok = await verifiedAssertion(options, challenge, p.assertion, stored, this.given.verifier);
    if (!ok || !stored || !(await credentials.advance(stored.credentialId, stored.counter, ok.counter, ctx.now))) return FAILED;
    return { ok: true, identity: { type: stored.identity.type, id: stored.identity.id }, method: 'webauthn', assurance: ok.userVerified ? 'aal2' : 'aal1' };
  }
}
