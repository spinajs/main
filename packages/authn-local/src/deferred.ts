import type { AuditLog } from './audit.js';

/**
 * In-process work that runs after the caller has its answer (D11). Errors are logged by name and never reach the caller;
 * `drain()` lets tests and shutdown wait for everything scheduled so far, including work scheduled while draining.
 */
export class DeferredWork {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly log: AuditLog) {}

  public defer(work: () => Promise<void>): void {
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(work)
      .catch((err) => this.log.warn(`Deferred authn-local work failed: ${(err as Error)?.name ?? typeof err}`))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  public async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }
}
