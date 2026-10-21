import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import { Autoinject, Injectable } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { AuthnAudit } from '@spinajs/authn/audit';
import type { AuthnAuditor, AuthnEventBody } from '@spinajs/authn/audit';
import { IdentityStore, PasskeyService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEventSink, IdentityRef, PasskeyCeremony, PasskeyEntry, PasskeyRegisterResult, PasskeyRegistration } from '@spinajs/authn/contracts';

import { WebAuthnCredentialExists, WebAuthnCredentialStore } from '../contracts.js';
import type { WebAuthnCredential } from '../contracts.js';
import { WebAuthnChallengeStore, newChallenge, takeChallenge } from '../challenge.js';
import { assertionOptions, registrationJson, registrationOptions, verifiedRegistration } from '../ceremony.js';
import { assertWebAuthnOptions } from '../options.js';
import type { WebAuthnOptions } from '../options.js';
import { NAME_MAX } from '../store/checks.js';

/** Left out, a dependency comes from DI; `identities: null` means none. */
export interface WebAuthnPasskeyServiceDeps {
  readonly credentials?: WebAuthnCredentialStore;
  readonly challenges?: WebAuthnChallengeStore;
  readonly options?: WebAuthnOptions;
  readonly identities?: IdentityStore | null;
  /** Published to through `AuthnAudit.over`; left out, the container's AuthnAudit. */
  readonly sinks?: readonly AuthnEventSink[];
}

const entryOf = (c: WebAuthnCredential): PasskeyEntry => ({
  id: c.credentialId,
  ...(c.name !== undefined ? { name: c.name } : {}),
  ...(c.transports ? { transports: [...c.transports] } : {}),
  createdAt: new Date(c.createdAt.getTime()),
  ...(c.lastUsedAt ? { lastUsedAt: new Date(c.lastUsedAt.getTime()) } : {}),
});

/**
 * PasskeyService on the WebAuthn stores: discoverable credentials, `none` attestation, audited as passkey.register and
 * passkey.remove. No event carries a challenge, a key or an attestation.
 */
@Injectable(PasskeyService)
export class WebAuthnPasskeyService extends PasskeyService {
  @Config('authn.webauthn')
  protected WebAuthnConfig: WebAuthnOptions;

  @Autoinject(WebAuthnCredentialStore, { optional: true })
  protected Credentials: WebAuthnCredentialStore | undefined;

  @Autoinject(WebAuthnChallengeStore, { optional: true })
  protected Challenges: WebAuthnChallengeStore | undefined;

  @Autoinject(IdentityStore, { optional: true })
  protected IdentityStore: IdentityStore | undefined;

  @Autoinject(AuthnAudit, { optional: true })
  protected Audit: AuthnAudit | undefined;

  private readonly sinkAudit: AuthnAuditor | undefined;

  constructor(protected readonly given: WebAuthnPasskeyServiceDeps = {}) {
    super();
    this.sinkAudit = given.sinks && AuthnAudit.over(given.sinks);
  }

  async challenge(ctx: AuthnContext, identity?: IdentityRef): Promise<PasskeyCeremony> {
    const { credentials, challenges, options } = this.deps();
    const challenge = newChallenge(identity ? 'mfa' : 'login', ctx.now, options.challengeTtlSeconds, identity);
    const request = await assertionOptions(options, challenge, identity ? await credentials.listFor(identity) : []);
    await challenges.put(challenge);
    return { challengeId: challenge.id, options: request as unknown as Readonly<Record<string, unknown>> };
  }

  async registrationOptions(id: IdentityRef, ctx: AuthnContext): Promise<PasskeyCeremony> {
    const { credentials, challenges, options } = this.deps();
    const challenge = newChallenge('register', ctx.now, options.challengeTtlSeconds, id);
    const identities = this.identities();
    const shown = identities ? await identities.display(id) : null;
    const creation = await registrationOptions(options, challenge, id, shown?.email || shown?.name || id.id, await credentials.listFor(id), true);
    await challenges.put(challenge);
    return { challengeId: challenge.id, options: creation as unknown as Readonly<Record<string, unknown>> };
  }

  async register(id: IdentityRef, registration: PasskeyRegistration, ctx: AuthnContext): Promise<PasskeyRegisterResult> {
    const { credentials, challenges, options } = this.deps();
    const name = registration?.name;
    const response = registrationJson(registration?.response);
    const challenge = await takeChallenge(challenges, registration?.challengeId, 'register', ctx.now, id);
    const valid = name === undefined || (typeof name === 'string' && name !== '' && [...name].length <= NAME_MAX);
    const credential = challenge && response && valid ? await verifiedRegistration(options, challenge, response, id, ctx.now, name) : null;
    if (!credential) {
      await this.audit(ctx, { type: 'passkey.register', outcome: 'failure', reason: 'invalid_response', identity: id });
      return { ok: false, code: 'invalid_response' };
    }
    try {
      await credentials.add(credential);
    } catch (err) {
      if (!(err instanceof WebAuthnCredentialExists)) throw err;
      await this.audit(ctx, { type: 'passkey.register', outcome: 'failure', reason: 'duplicate', identity: id });
      return { ok: false, code: 'duplicate' };
    }
    await this.audit(ctx, { type: 'passkey.register', outcome: 'success', identity: id, data: { aaguid: credential.aaguid ?? null } });
    return { ok: true, passkey: entryOf(credential) };
  }

  async list(id: IdentityRef): Promise<readonly PasskeyEntry[]> {
    const { credentials } = this.deps();
    return (await credentials.listFor(id)).map(entryOf);
  }

  async remove(id: IdentityRef, credentialId: string, ctx: AuthnContext): Promise<boolean> {
    const { credentials } = this.deps();
    const removed = typeof credentialId === 'string' && credentialId !== '' && (await credentials.remove(id, credentialId));
    if (removed) await this.audit(ctx, { type: 'passkey.remove', outcome: 'success', identity: id });
    return removed;
  }

  private async audit(ctx: AuthnContext, e: AuthnEventBody): Promise<void> {
    const auditor = this.sinkAudit ?? this.Audit;
    if (!auditor) throw new InvalidOperation('WebAuthnPasskeyService: no AuthnAudit is registered');
    await auditor.publishIn(ctx, e);
  }

  private identities(): IdentityStore | null {
    return this.given.identities !== undefined ? this.given.identities : (this.IdentityStore ?? null);
  }

  private deps(): { credentials: WebAuthnCredentialStore; challenges: WebAuthnChallengeStore; options: WebAuthnOptions } {
    const credentials = this.given.credentials ?? this.Credentials;
    const challenges = this.given.challenges ?? this.Challenges;
    if (!credentials || !challenges) throw new InvalidOperation('WebAuthnPasskeyService: no WebAuthnCredentialStore or WebAuthnChallengeStore is registered; import "@spinajs/authn-webauthn/db" or register both');
    return { credentials, challenges, options: assertWebAuthnOptions(this.given.options ?? this.WebAuthnConfig) };
  }
}
