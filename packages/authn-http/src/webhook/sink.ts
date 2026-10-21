import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import '@spinajs/authn/register-schema';
import { AuthnEventSink } from '@spinajs/authn/contracts';
import type { AuthnEvent } from '@spinajs/authn/contracts';
import { Log, Logger } from '@spinajs/log';

import { WEBHOOK_SIGNATURE_HEADER, signWebhook } from './sign.js';

const DEFAULT_TIMEOUT_MS = 2000;

/** One `authn.webhooks` entry as configured. */
export interface AuthnWebhookTarget {
  readonly url: string;
  readonly secret: { readonly secret: string };
  /** Event types delivered; all when absent. */
  readonly types?: readonly string[];
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

/**
 * POSTs each matching audit event, signed, to every `authn.webhooks` target. The body is the event as the other sinks get it.
 * A failed delivery is logged and dropped; publish never rejects.
 */
@Injectable(AuthnEventSink)
export class WebhookAuthnEventSink extends AuthnEventSink {
  @Config('authn.webhooks')
  protected Webhooks: readonly AuthnWebhookTarget[] | undefined;

  @Logger('authn-webhook')
  protected Log: Log;

  public async publish(e: AuthnEvent): Promise<void> {
    const targets = (this.Webhooks ?? []).filter((t) => t.types === undefined || t.types.includes(e.type));
    if (targets.length === 0) return;

    let body: string;
    try {
      body = JSON.stringify(e);
    } catch (err) {
      this.Log.warn({ eventType: e.type, errorClass: errorClass(err) }, 'authn webhook: a ${eventType} event is not serialisable (${errorClass})');
      return;
    }
    await Promise.all(targets.map((t) => this.post(t, e.type, body)));
  }

  private async post(target: AuthnWebhookTarget, eventType: string, body: string): Promise<void> {
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
      if (!response.ok) this.Log.warn({ target: where, eventType, status: response.status }, 'authn webhook: ${target} answered HTTP ${status} to a ${eventType} event');
    } catch (err) {
      this.Log.warn({ target: where, eventType, errorClass: errorClass(err) }, 'authn webhook: delivery of a ${eventType} event to ${target} failed (${errorClass})');
    }
  }
}

// An error message can echo the URL, so only the class is logged.
const errorClass = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
