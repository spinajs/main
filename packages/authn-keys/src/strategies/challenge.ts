import { Autoinject, Injectable } from '@spinajs/di';
import { AuthenticationStrategy, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { InvalidOption } from '@spinajs/exceptions';
import { challengeSecretPurpose, challengeSigningInput, parseChallengeId, verifyChallengeSignature } from '../challenge/challenge.js';
import { decodeB64url } from '../jwk/base64url.js';
import { loginChallengeIdentity } from '../registry/registry.js';
import { KeyStrategy, MAX_CREDENTIAL_LENGTH, failure, keyThrottleKeys, usableKey } from './keys.js';
import type { KeyStrategyDeps } from './keys.js';

export interface KeyChallengeStrategyDeps extends KeyStrategyDeps {
  readonly secrets?: SecretStore;
}

/**
 * Challenge-response login for CLIs that want a session (design §22.10): `POST /auth/keys/challenge` gives a
 * challenge for a kid, the client signs `spinajs-key-login:<nonce>:<audience>` with that key, and `POST /auth/keys/login` sends
 * `{ keyId, challengeId, signature }`. The signing input names this service (lane notes D6). The challenge is redeemed only after the signature holds, so a wrong signature
 * burns nothing (the throttle counts it).
 */
@Injectable(AuthenticationStrategy)
export class KeyChallengeStrategy extends KeyStrategy<KeyChallengeStrategyDeps> {
  readonly name = 'keys-challenge';
  readonly kinds = ['key-challenge'];
  readonly interactive = true;

  @Autoinject(SecretStore)
  protected Secrets: SecretStore;

  protected get secrets(): SecretStore {
    return this.Deps?.secrets ?? this.Secrets;
  }

  protected get audience(): string {
    const audience = this.options.challenge.audience;
    if (audience === null) {
      throw new InvalidOption('authn.keys.challenge.audience (or authn.keys.assertion.audience) must be set for key challenge logins');
    }
    return audience;
  }

  public async resolve(): Promise<void> {
    void this.audience;
    await super.resolve();
  }

  throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    return keyThrottleKeys(c.kind === 'key-challenge' && typeof c.keyId === 'string' ? c.keyId : null, ctx);
  }

  async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    if (c.kind !== 'key-challenge') {
      return failure('unsupported_credentials');
    }
    const { keyId, challengeId, signature } = c as { keyId?: unknown; challengeId?: unknown; signature?: unknown };
    if (typeof keyId !== 'string' || typeof signature !== 'string' || typeof challengeId !== 'string' || keyId.length + challengeId.length + signature.length > MAX_CREDENTIAL_LENGTH) {
      return failure('invalid_credentials');
    }
    const parsed = parseChallengeId(challengeId);
    const found = await usableKey(this.registry, keyId, ctx);
    if (!found.key || !parsed) {
      this.unknownKeyWork((found.key ? found.key.alg : found.alg) ?? 'EdDSA', challengeSigningInput({ nonce: parsed?.nonce ?? '' }, 'login', this.audience), decodeB64url(signature) ?? Buffer.alloc(0));
      return failure(found.key ? 'invalid_credentials' : found.reason);
    }
    if (!verifyChallengeSignature(found.key, parsed.nonce, 'login', this.audience, signature)) {
      return failure('invalid_credentials');
    }
    if (!(await this.secrets.redeem(loginChallengeIdentity(keyId), challengeSecretPurpose(parsed.rid), parsed.nonce))) {
      return failure('invalid_credentials');
    }
    return this.success(found.key, 'key-challenge', ctx);
  }
}
