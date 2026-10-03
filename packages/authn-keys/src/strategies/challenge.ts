import { Inject, Injectable } from '@spinajs/di';
import { AuthenticationStrategy, KeyRegistry, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, StrategyOutcome, ThrottleKey } from '@spinajs/authn/contracts';
import { challengeSecretPurpose, challengeSigningInput, parseChallengeId, verifyChallengeSignature } from '../challenge/challenge.js';
import { decodeB64url } from '../jwk/base64url.js';
import { dummyVerify } from '../jwk/signature.js';
import { loginChallengeIdentity } from '../registry/registry.js';
import { failure, keySuccess, keyThrottleKeys, usableKey } from './keys.js';

/**
 * Challenge-response login for CLIs that want a session (design §22.10): `POST /auth/keys/challenge` gives a
 * challenge for a kid, the client signs `spinajs-key-login:<nonce>` with that key, and `POST /auth/keys/login` sends
 * `{ keyId, challengeId, signature }`. The challenge is redeemed only after the signature holds, so a wrong signature
 * burns nothing (the throttle counts it).
 */
@Injectable(AuthenticationStrategy)
@Inject(KeyRegistry, SecretStore)
export class KeyChallengeStrategy extends AuthenticationStrategy {
  readonly name = 'keys-challenge';
  readonly kinds = ['key-challenge'];
  readonly interactive = true;

  constructor(protected readonly registry: KeyRegistry, protected readonly secrets: SecretStore) {
    super();
  }

  throttleKeys(c: Credentials, ctx: AuthnContext): readonly ThrottleKey[] {
    return keyThrottleKeys(c.kind === 'key-challenge' && typeof c.keyId === 'string' ? c.keyId : null, ctx);
  }

  async verify(c: Credentials, ctx: AuthnContext): Promise<StrategyOutcome> {
    if (c.kind !== 'key-challenge') {
      return failure('unsupported_credentials');
    }
    const { keyId, challengeId, signature } = c as { keyId?: unknown; challengeId?: unknown; signature?: unknown };
    if (typeof keyId !== 'string' || typeof signature !== 'string') {
      return failure('invalid_credentials');
    }
    const parsed = parseChallengeId(challengeId);
    const found = await usableKey(this.registry, keyId, ctx);
    if (!found.key || !parsed) {
      dummyVerify('EdDSA', challengeSigningInput({ nonce: parsed?.nonce ?? '' }, 'login'), decodeB64url(signature) ?? Buffer.alloc(0));
      return failure(found.key ? 'invalid_credentials' : found.reason);
    }
    if (!verifyChallengeSignature(found.key, parsed.nonce, 'login', signature)) {
      return failure('invalid_credentials');
    }
    if (!(await this.secrets.redeem(loginChallengeIdentity(keyId), challengeSecretPurpose(parsed.rid), parsed.nonce))) {
      return failure('invalid_credentials');
    }
    return keySuccess(this.registry, found.key, 'key-challenge', ctx);
  }
}
