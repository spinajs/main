import { DI } from '@spinajs/di';
import { PasswordService } from '@spinajs/authn/contracts';
import { Job, QueueJob } from '@spinajs/queue';

import { authnMailDeliveryOf } from '../mail/contracts.js';
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

  public static of(request: AuthnMailRequest): AuthnMailJob {
    const job = new AuthnMailJob();
    job.identityType = request.identity.type;
    job.identityId = request.identity.id;
    job.purpose = request.purpose;
    job.ttlSeconds = request.ttlSeconds;
    job.requestedAt = request.requestedAt.toISOString();
    if (request.lang) {
      job.lang = request.lang;
    }
    return job;
  }

  /** `result: false` when the mail was not sent: the request outlived its ttl, or there is no mailer or address. */
  public async execute(): Promise<{ result: boolean }> {
    const deliver = authnMailDeliveryOf(await DI.resolve(PasswordService));
    const result = await deliver({
      identity: { type: this.identityType, id: this.identityId },
      purpose: this.purpose,
      ttlSeconds: this.ttlSeconds,
      requestedAt: new Date(this.requestedAt),
      ...(this.lang ? { lang: this.lang } : {}),
    });
    return { result };
  }
}
