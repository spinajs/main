import { Injectable } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { OrmScope, OrmScopePolicy, registerAccessResource } from '@spinajs/authz-orm';
import { SYSTEM } from '@spinajs/authz';
import type { Principal } from '@spinajs/authz';
import { JobModel, QueueTrackingHook } from '@spinajs/queue';
import type { IWhereBuilder } from '@spinajs/orm';
import type { ModelBase } from '@spinajs/orm';

import { authzFor } from '../hook/service.js';
import './job-grant.js';

/** The rows a principal emitted: relation `initiator` of the `job` type. */
@OrmScope(JobModel, 'initiator')
export class JobInitiatorScope extends OrmScopePolicy<JobModel> {
  scope(query: IWhereBuilder<ModelBase>, principal: Principal): void {
    query.where('InitiatorType', principal.type).where('InitiatorId', principal.id);
  }
}

registerAccessResource(JobModel, 'job');

/** The queue's own job-row queries run as SYSTEM: the job's principal may not touch the table. */
@Injectable(QueueTrackingHook)
export class AuthzQueueTrackingHook extends QueueTrackingHook {
  @Config('authz.queue.domain')
  protected Domain: string;

  async aroundTracking<T>(next: () => Promise<T>): Promise<T> {
    return (await authzFor(this.Domain)).runAs(SYSTEM, 'queue:tracking', next);
  }
}
