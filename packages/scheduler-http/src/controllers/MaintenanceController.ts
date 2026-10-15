import { BasePath, Ok, Policy, Post } from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';

import { SchedulerControllerBase } from '../scheduler-controller.js';
import { SCHEDULER_MANAGE, SCHEDULER_READ, SCHEDULER_RESOURCE } from '../permissions.js';

/**
 * Scheduler maintenance.
 * @tags Scheduler
 */
@BasePath('scheduler')
@Policy(AuthorizedPolicy)
@Resource(SCHEDULER_RESOURCE, SCHEDULER_READ)
export class MaintenanceController extends SchedulerControllerBase {
  /**
   * Prune scheduler data
   * Removes orphaned schedules, plus runs, logs and resolved errors past retention.
   * @security cookieAuth
   * @returns {PruneResult} Number of removed records per kind
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny on the scheduler resource required
   */
  @Post('prune')
  @Permission(SCHEDULER_MANAGE)
  public async prune() {
    return new Ok(await this.Scheduler.prune({ triggeredBy: this.triggeredBy() }));
  }
}
