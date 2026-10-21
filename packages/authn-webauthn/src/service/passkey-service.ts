import { Config } from '@spinajs/configuration';
import '../register-schema.js';
import { Autoinject, Injectable } from '@spinajs/di';
import { AuthnAudit } from '@spinajs/authn/audit';
import { IdentityStore, PasskeyService } from '@spinajs/authn/contracts';
import type { AuthnContext, AuthnEventSink, IdentityRef, PasskeyCeremony, PasskeyEntry, PasskeyRegisterResult, PasskeyRegistration } from '@spinajs/authn/contracts';

import { WebAuthnCredentialStore } from '../contracts.js';
import { WebAuthnChallengeStore } from '../challenge.js';
import type { WebAuthnOptions } from '../options.js';

/** Left out, a dependency comes from DI; `identities: null` means none. */
export interface WebAuthnPasskeyServiceDeps {
  readonly credentials?: WebAuthnCredentialStore;
  readonly challenges?: WebAuthnChallengeStore;
  readonly options?: WebAuthnOptions;
  readonly identities?: IdentityStore | null;
  /** Published to through `AuthnAudit.over`; left out, the container's AuthnAudit. */
  readonly sinks?: readonly AuthnEventSink[];
}

/** PasskeyService on the WebAuthn stores: discoverable credentials, `none` attestation, audited as passkey.register and passkey.remove. */
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

  constructor(protected readonly given: WebAuthnPasskeyServiceDeps = {}) {
    super();
  }

  challenge(_ctx: AuthnContext, _identity?: IdentityRef): Promise<PasskeyCeremony> {
    throw new Error('not implemented: WebAuthnPasskeyService.challenge');
  }

  registrationOptions(_id: IdentityRef, _ctx: AuthnContext): Promise<PasskeyCeremony> {
    throw new Error('not implemented: WebAuthnPasskeyService.registrationOptions');
  }

  register(_id: IdentityRef, _registration: PasskeyRegistration, _ctx: AuthnContext): Promise<PasskeyRegisterResult> {
    throw new Error('not implemented: WebAuthnPasskeyService.register');
  }

  list(_id: IdentityRef): Promise<readonly PasskeyEntry[]> {
    throw new Error('not implemented: WebAuthnPasskeyService.list');
  }

  remove(_id: IdentityRef, _credentialId: string, _ctx: AuthnContext): Promise<boolean> {
    throw new Error('not implemented: WebAuthnPasskeyService.remove');
  }
}
