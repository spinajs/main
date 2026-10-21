import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';

import { CredentialChangeBus } from '../contracts/credential-bus.js';
import type { CredentialChange } from '../contracts/credential-bus.js';

/** Delivers each change synchronously to the listeners of this process. */
@Injectable(CredentialChangeBus)
export class InProcessCredentialChangeBus extends CredentialChangeBus {
  @Logger('authn')
  protected Log: Log;

  private readonly listeners = new Set<(change: CredentialChange) => void>();

  public publish(change: CredentialChange): Promise<void> {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (err) {
        this.report(err, change);
      }
    }
    return Promise.resolve();
  }

  public subscribe(listener: (change: CredentialChange) => void): () => void {
    // Wrapped, so the same function subscribed twice holds two subscriptions.
    const entry = (change: CredentialChange) => listener(change);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  /** A failing listener must not stop the others, nor the revoke that published. */
  protected report(err: unknown, change: CredentialChange): void {
    try {
      this.Log.error({ error: err, kind: change.kind }, 'A credential change listener failed on a ${kind} change');
    } catch {
      // Built with new, outside a container with a logger.
    }
  }
}
