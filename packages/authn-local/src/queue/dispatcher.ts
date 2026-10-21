import type { QueueService } from '@spinajs/queue';

import { AuthnMailDispatcher } from '../mail/contracts.js';
import type { AuthnMailRequest } from '../mail/contracts.js';

/** Emits an `AuthnMailJob` per request (`authn.local.mail.delivery: 'queue'`); a queue consumer delivers it. */
export class QueueAuthnMailDispatcher extends AuthnMailDispatcher {
  /** Without `queue`, the container's `QueueService`. */
  constructor(protected readonly Queue?: Pick<QueueService, 'emit'>) {
    super();
  }

  public dispatch(_request: AuthnMailRequest): Promise<void> {
    throw new Error('not implemented: QueueAuthnMailDispatcher.dispatch');
  }

  public drain(): Promise<void> {
    throw new Error('not implemented: QueueAuthnMailDispatcher.drain');
  }
}
