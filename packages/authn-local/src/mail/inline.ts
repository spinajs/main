import type { AuditLog } from '../audit.js';
import { DeferredWork } from '../deferred.js';
import { AuthnMailDispatcher } from './contracts.js';
import type { AuthnMailDelivery, AuthnMailRequest } from './contracts.js';

/**
 * Delivers in this process, after the caller has its answer (`authn.local.mail.delivery: 'inline'`). A failed delivery is
 * logged by its error name and never reaches the caller; nothing retries it.
 */
export class InlineAuthnMailDispatcher extends AuthnMailDispatcher {
  private readonly work: DeferredWork;

  constructor(
    protected readonly Delivery: AuthnMailDelivery,
    log: AuditLog,
  ) {
    super();
    this.work = new DeferredWork(log);
  }

  public async dispatch(request: AuthnMailRequest): Promise<void> {
    this.work.defer(async () => {
      await this.Delivery(request);
    });
  }

  public drain(): Promise<void> {
    return this.work.drain();
  }
}
