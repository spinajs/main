import type { IdentityRef } from '@spinajs/authn/contracts';

/** Each later feature appends its purpose: FEAT-2 'verify', FEAT-3 'code', FEAT-4 'account-exists'. */
export type AuthnMailPurpose = 'reset' | 'invite';

/** Holds no secret: the secret or code is issued when the mail is delivered (SR-09). */
export interface AuthnMailRequest {
  readonly identity: IdentityRef;
  readonly purpose: AuthnMailPurpose;
  readonly ttlSeconds: number;
  readonly requestedAt: Date;
  readonly lang?: string;
}

/** Issues the secret and sends the mail at once; `LocalPasswordService.deliver`. */
export type AuthnMailDelivery = (request: AuthnMailRequest) => Promise<boolean>;

/**
 * Hands an authn mail request on for delivery after the caller has its answer. `authn.local.mail.delivery` picks the
 * implementation: `QueueAuthnMailDispatcher` (`@spinajs/authn-local/queue`) or `InlineAuthnMailDispatcher`.
 */
export abstract class AuthnMailDispatcher {
  public abstract dispatch(request: AuthnMailRequest): Promise<void>;

  /** Resolves when everything dispatched so far has been delivered (inline) or handed to the queue (queue). Tests and shutdown. */
  public abstract drain(): Promise<void>;
}
