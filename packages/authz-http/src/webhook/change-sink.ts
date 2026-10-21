import { Singleton } from '@spinajs/di';
import type { AuthzChange, ChangeBus } from '@spinajs/authz';

/** One `authz.http.webhooks` entry as configured. */
export interface AuthzWebhookTarget {
  readonly url: string;
  readonly secret: { readonly secret: string };
  readonly timeoutMs?: number;
}

/** POSTs every ChangeBus publish, signed, to each `authz.http.webhooks` target. */
@Singleton()
export class WebhookChangeSink {
  /** Subscribes to `bus`; the returned function unsubscribes. */
  public start(_bus: ChangeBus): () => void {
    throw new Error('not implemented: WebhookChangeSink.start');
  }

  /** Never rejects. */
  public async deliver(_change: AuthzChange): Promise<void> {
    throw new Error('not implemented: WebhookChangeSink.deliver');
  }
}
