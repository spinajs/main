import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { IdentityStore, MfaStep } from '@spinajs/authn/contracts';
import type { IdentityRef, PasskeyCeremony } from '@spinajs/authn/contracts';
import { isPlainObject } from '@spinajs/util';

import { WebAuthnCredentialExists, WebAuthnCredentialStore } from '../contracts.js';
import { WebAuthnChallengeStore, newChallenge, takeChallenge } from '../challenge.js';
import { assertionJson, assertionOptions, registrationJson, registrationOptions, verifiedAssertion, verifiedRegistration } from '../ceremony.js';
import { assertWebAuthnOptions } from '../options.js';
import type { WebAuthnOptions } from '../options.js';
import { NAME_MAX } from '../store/checks.js';
import { WebAuthnInvalidResponse, WebAuthnNotEnrolled } from './errors.js';
import { WebAuthnRecoveryCodeStore, newRecoveryCodeSet, normaliseRecoveryCode, showRecoveryCode } from './recovery.js';

/** Left out, a dependency comes from DI; `identities: null` means none. */
export interface WebAuthnMfaStepDeps {
  readonly credentials?: WebAuthnCredentialStore;
  readonly challenges?: WebAuthnChallengeStore;
  readonly recoveryCodes?: WebAuthnRecoveryCodeStore;
  readonly options?: WebAuthnOptions;
  readonly identities?: IdentityStore | null;
}

interface Resolved {
  readonly credentials: WebAuthnCredentialStore;
  readonly challenges: WebAuthnChallengeStore;
  readonly recoveryCodes: WebAuthnRecoveryCodeStore | null;
  readonly options: WebAuthnOptions;
  readonly identities: IdentityStore | null;
}

/** Longer step strings are refused unparsed; an attestation with its certificate chain fits well below this. */
const RESPONSE_MAX = 64 * 1024;

function parsed(response: unknown): Record<string, unknown> | null {
  if (typeof response !== 'string' || response === '' || response.length > RESPONSE_MAX) return null;
  try {
    const v: unknown = JSON.parse(response);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
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

  private resolved: Resolved | null = null;

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

  /**
   * Without a credential store nothing can be enrolled, so false rather than a throw: TotpService asks every registered
   * MfaStep, also in apps that load this package but use only TOTP.
   */
  async enrolled(id: IdentityRef): Promise<boolean> {
    const credentials = this.given.credentials ?? this.Credentials;
    return !!credentials && (await credentials.listFor(id)).length > 0;
  }

  /** A later begin does not void an earlier one: each challenge stays good until it is used or expires. */
  async beginEnrolment(id: IdentityRef): Promise<{ provisioning: string }> {
    const { credentials, challenges, options, identities } = this.deps();
    const challenge = newChallenge('register', new Date(), options.challengeTtlSeconds, id);
    const shown = identities ? await identities.display(id) : null;
    const creation = await registrationOptions(options, challenge, id, shown?.email || shown?.name || id.id, await credentials.listFor(id), false);
    await challenges.put(challenge);
    return { provisioning: JSON.stringify({ challengeId: challenge.id, options: creation }) };
  }

  /** Throws `WebAuthnInvalidResponse` for a response that does not register a new credential of `id`. */
  async confirmEnrolment(id: IdentityRef, response: string): Promise<{ recoveryCodes?: readonly string[] }> {
    const { credentials, challenges, recoveryCodes, options } = this.deps();
    const body = parsed(response);
    const name = body?.name;
    const attestation = registrationJson(body?.response);
    if (!body || !attestation || (name !== undefined && (typeof name !== 'string' || [...name].length > NAME_MAX))) throw new WebAuthnInvalidResponse('not a WebAuthn registration response');
    const now = new Date();
    const challenge = await takeChallenge(challenges, body.challengeId, 'register', now, id);
    const credential = challenge && (await verifiedRegistration(options, challenge, attestation, id, now, name as string | undefined));
    if (!credential) throw new WebAuthnInvalidResponse('the WebAuthn registration does not verify');
    try {
      await credentials.add(credential);
    } catch (err) {
      if (err instanceof WebAuthnCredentialExists) throw new WebAuthnInvalidResponse('the WebAuthn credential is registered already');
      throw err;
    }
    if (!recoveryCodes || options.recoveryCodes === 0) return {};
    return { recoveryCodes: await this.issueRecoveryCodes(id) };
  }

  /** Assertion options for the identity's own credentials, for `verify`. */
  async challenge(id: IdentityRef): Promise<PasskeyCeremony> {
    const { credentials, challenges, options } = this.deps();
    const challenge = newChallenge('mfa', new Date(), options.challengeTtlSeconds, id);
    const request = await assertionOptions(options, challenge, await credentials.listFor(id));
    await challenges.put(challenge);
    return { challengeId: challenge.id, options: request as unknown as Readonly<Record<string, unknown>> };
  }

  async verify(id: IdentityRef, response: string): Promise<boolean> {
    const { credentials, challenges, options } = this.deps();
    const body = parsed(response);
    const assertion = assertionJson(body?.response);
    if (!body || !assertion) return false;
    const now = new Date();
    const challenge = await takeChallenge(challenges, body.challengeId, 'mfa', now, id);
    if (!challenge) return false;
    const stored = await credentials.get(assertion.id);
    const owned = stored && stored.identity.type === id.type && stored.identity.id === id.id ? stored : null;
    const ok = await verifiedAssertion(options, challenge, assertion, owned);
    return !!ok && !!owned && (await credentials.advance(owned.credentialId, owned.counter, ok.counter, now));
  }

  /** Takes a recovery code only; single use. */
  async verifyRecovery(id: IdentityRef, code: string): Promise<boolean> {
    const { recoveryCodes } = this.deps();
    const normalised = normaliseRecoveryCode(code);
    if (!recoveryCodes || normalised === null || !(await this.enrolled(id))) return false;
    return recoveryCodes.redeem(id, normalised);
  }

  /** Voids the old set; the new codes are returned once. */
  async regenerateRecoveryCodes(id: IdentityRef): Promise<readonly string[]> {
    if (!(await this.enrolled(id))) throw new WebAuthnNotEnrolled('no WebAuthn credential is registered for this identity');
    return this.issueRecoveryCodes(id);
  }

  async disable(id: IdentityRef): Promise<void> {
    const { credentials, recoveryCodes } = this.deps();
    for (const c of await credentials.listFor(id)) await credentials.remove(id, c.credentialId);
    await recoveryCodes?.remove(id);
  }

  private async issueRecoveryCodes(id: IdentityRef): Promise<readonly string[]> {
    const { recoveryCodes, options } = this.deps();
    if (!recoveryCodes) throw new InvalidOperation('WebAuthnMfaStep: no WebAuthnRecoveryCodeStore is registered; import "@spinajs/authn-webauthn/db" or register one');
    const codes = newRecoveryCodeSet(options.recoveryCodes);
    await recoveryCodes.replace(id, codes);
    return Object.freeze(codes.map(showRecoveryCode));
  }

  private deps(): Resolved {
    if (this.resolved) return this.resolved;
    const credentials = this.given.credentials ?? this.Credentials;
    const challenges = this.given.challenges ?? this.Challenges;
    if (!credentials || !challenges) throw new InvalidOperation('WebAuthnMfaStep: no WebAuthnCredentialStore or WebAuthnChallengeStore is registered; import "@spinajs/authn-webauthn/db" or register both');
    const options = assertWebAuthnOptions(this.given.options ?? this.WebAuthnConfig);
    const identities = this.given.identities !== undefined ? this.given.identities : (this.IdentityStore ?? null);
    this.resolved = { credentials, challenges, recoveryCodes: this.given.recoveryCodes ?? this.RecoveryCodes ?? null, options, identities };
    return this.resolved;
  }
}
