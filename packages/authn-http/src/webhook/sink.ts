import { Injectable } from '@spinajs/di';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';

/** One `authn.webhooks` entry as configured. */
export interface AuthnWebhookTarget {
  readonly url: string;
  readonly secret: { readonly secret: string };
  /** Event types delivered; all when absent. */
  readonly types?: readonly string[];
  readonly timeoutMs?: number;
}

/** POSTs each matching audit event, signed, to every `authn.webhooks` target. */
@Injectable(AuthnEventSink)
export class WebhookAuthnEventSink extends AuthnEventSink {
  public async publish(_e: AuthnEvent): Promise<void> {
    throw new Error('not implemented: WebhookAuthnEventSink.publish');
  }
}
