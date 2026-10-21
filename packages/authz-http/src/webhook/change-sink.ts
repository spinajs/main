import { Singleton } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { AUTHZ_CHANGED_EVENT } from '@spinajs/authz';
import type { AuthzChange, ChangeBus } from '@spinajs/authz';
import { Log, Logger } from '@spinajs/log';

import { WEBHOOK_SIGNATURE_HEADER, signWebhook } from './sign.js';

const DEFAULT_TIMEOUT_MS = 2000;

/** One `authz.http.webhooks` entry as configured. */
export interface AuthzWebhookTarget {
  readonly url: string;
  readonly secret: { readonly secret: string };
  readonly timeoutMs?: number;
}

// A URL may carry a token in its query, so only the origin is ever logged.
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'invalid-url';
  }
}

// An error message can echo the URL, so only the class is logged.
const errorClass = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * POSTs `{ kind, domain?, tags, at }` for every ChangeBus publish to each `authz.http.webhooks` target. The actor is not sent.
 * A failed delivery is logged and dropped.
 */
@Singleton()
export class WebhookChangeSink {
  @Config('authz.http.webhooks')
  protected Webhooks: readonly AuthzWebhookTarget[] | undefined;

  @Logger('authz-webhook')
  protected Log: Log;

  /** Subscribes to `bus`; the returned function unsubscribes. */
  public start(bus: ChangeBus): () => void {
    return bus.subscribe((change) => {
      void this.deliver(change);
    });
  }

  /** Never rejects. */
  public async deliver(change: AuthzChange): Promise<void> {
    const targets = this.Webhooks ?? [];
    if (targets.length === 0) return;

    const body = JSON.stringify({ kind: AUTHZ_CHANGED_EVENT, ...(change.domain === undefined ? {} : { domain: change.domain }), tags: change.tags, at: change.at });
    await Promise.all(targets.map((t) => this.post(t, body)));
  }

  private async post(target: AuthzWebhookTarget, body: string): Promise<void> {
    const where = originOf(target.url);
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [WEBHOOK_SIGNATURE_HEADER]: signWebhook(target.secret.secret, body) },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(target.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (!response.ok) this.Log.warn({ target: where, status: response.status }, 'authz webhook: ${target} answered HTTP ${status} to a change');
    } catch (err) {
      this.Log.warn({ target: where, errorClass: errorClass(err) }, 'authz webhook: delivery of a change to ${target} failed (${errorClass})');
    }
  }
}
