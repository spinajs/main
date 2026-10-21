import type { IdentityRef } from '@spinajs/authn/contracts';

import type { AuthnMailPurpose } from './mail/contracts.js';

export interface PasswordMail {
  readonly identity: IdentityRef;
  readonly purpose: AuthnMailPurpose;
  readonly to: { readonly email?: string; readonly name?: string };
  /** The raw single-use secret; the link is built from it and `url`. */
  readonly secret: string;
  /** `authn.local.reset.url`, the page that redeems the secret. */
  readonly url: string;
  readonly ttlSeconds: number;
  readonly lang?: string;
}

/**
 * Sends reset and invite mails. The secret is issued right before `send` and exists nowhere else, so an implementation renders
 * and sends at once and never puts `secret` (or the link holding it) into a queued, persisted or logged payload (SR-09). A
 * failure must not carry the secret in its error either.
 */
export abstract class PasswordMailer {
  public abstract send(mail: PasswordMail): Promise<void>;
}
