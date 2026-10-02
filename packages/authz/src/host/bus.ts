import { Injectable, Singleton } from '@spinajs/di';
import { ChangeBus } from '../contracts/service.js';
import type { AuthzChange } from '../contracts/service.js';
import { engineLog } from './log.js';

@Singleton()
@Injectable(ChangeBus)
export class InProcessChangeBus extends ChangeBus {
  private readonly subscribers = new Set<(c: AuthzChange) => void>();
  private readonly log = engineLog('authz-bus');

  async publish(change: AuthzChange): Promise<void> {
    // Snapshot: a subscriber may unsubscribe (or subscribe) while we deliver.
    for (const fn of [...this.subscribers]) {
      const fail = (err: unknown) => this.log.error(`authz change subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        const r = fn(change) as unknown;
        if (r !== null && typeof r === 'object' && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, fail);
      } catch (err) {
        fail(err);
      }
    }
  }

  subscribe(fn: (c: AuthzChange) => void): () => void {
    // A wrapper keeps two subscriptions of the same function independent.
    const entry = (c: AuthzChange) => fn(c);
    this.subscribers.add(entry);
    return () => {
      this.subscribers.delete(entry);
    };
  }
}
