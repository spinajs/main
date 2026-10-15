import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { registerAccessResource } from '@spinajs/authz-orm';
import { SYSTEM } from '@spinajs/authz';
import { JobModel, QueueTrackingHook } from '@spinajs/queue';

import { authzFor } from '../hook/service.js';
import './job-grant.js';

// The initiator may be any principal type, so the owner relation compares the type column too.
registerAccessResource(JobModel, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } });

/** The queue's own job-row queries run as SYSTEM: the job's principal may not touch the table. */
@Injectable(QueueTrackingHook)
export class AuthzQueueTrackingHook extends QueueTrackingHook {
  @Config('authz.queue.domain')
  protected Domain: string;

  async aroundTracking<T>(next: () => Promise<T>): Promise<T> {
    return (await authzFor(this.Domain)).runAs(SYSTEM, 'queue:tracking', next);
  }
}
