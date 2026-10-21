import { DI } from '@spinajs/di';
import { QueueService } from '@spinajs/queue';

import { AuthnMailDispatcher } from '../mail/contracts.js';
import type { AuthnMailRequest } from '../mail/contracts.js';
import { AuthnMailJob } from './job.js';

/** Emits an `AuthnMailJob` per request (`authn.local.mail.delivery: 'queue'`); a queue consumer delivers it. */
export class QueueAuthnMailDispatcher extends AuthnMailDispatcher {
  private readonly pending = new Set<Promise<void>>();

  /** Without `queue`, the container's `QueueService`. */
  constructor(protected readonly Queue?: Pick<QueueService, 'emit'>) {
    super();
  }

  public async dispatch(request: AuthnMailRequest): Promise<void> {
    const emitted = this.emit(AuthnMailJob.of(request));
    this.pending.add(emitted);
    try {
      await emitted;
    } finally {
      this.pending.delete(emitted);
    }
  }

  public async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  private async emit(job: AuthnMailJob): Promise<void> {
    const queue = this.Queue ?? (await DI.resolve(QueueService));
    await queue.emit(job);
  }
}
