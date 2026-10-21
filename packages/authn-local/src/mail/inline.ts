import type { AuditLog } from '../audit.js';
import { AuthnMailDispatcher } from './contracts.js';
import type { AuthnMailDelivery, AuthnMailRequest } from './contracts.js';

/** Delivers in this process, after the caller has its answer (`authn.local.mail.delivery: 'inline'`). */
export class InlineAuthnMailDispatcher extends AuthnMailDispatcher {
  constructor(
    protected readonly Delivery: AuthnMailDelivery,
    protected readonly DispatchLog: AuditLog,
  ) {
    super();
  }

  public dispatch(_request: AuthnMailRequest): Promise<void> {
    throw new Error('not implemented: InlineAuthnMailDispatcher.dispatch');
  }

  public drain(): Promise<void> {
    throw new Error('not implemented: InlineAuthnMailDispatcher.drain');
  }
}
