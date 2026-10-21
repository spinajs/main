import { Job, QueueJob } from '@spinajs/queue';

import type { AuthnMailPurpose, AuthnMailRequest } from '../mail/contracts.js';

/**
 * Delivers one authn mail from the queue. The payload names the identity and the purpose only: the secret is issued, the
 * mail rendered and sent with `EmailService.send` when the job runs (SR-09), so a retry voids the secret of the earlier run.
 */
@Job({ runAs: 'system' })
export class AuthnMailJob extends QueueJob {
  public identityType: string;
  public identityId: string;
  public purpose: AuthnMailPurpose;
  public ttlSeconds: number;
  /** ISO 8601 */
  public requestedAt: string;
  public lang?: string;

  public static of(_request: AuthnMailRequest): AuthnMailJob {
    throw new Error('not implemented: AuthnMailJob.of');
  }

  public async execute(): Promise<{ result: boolean }> {
    throw new Error('not implemented: AuthnMailJob.execute');
  }
}
