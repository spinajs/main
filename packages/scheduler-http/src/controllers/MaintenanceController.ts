import { BasePath, Ok, Post } from '@spinajs/http';
import { Access } from '@spinajs/authz-http';

import { SchedulerControllerBase } from '../scheduler-controller.js';
import { SCHEDULER_MANAGE } from '../permissions.js';

/**
 * Scheduler maintenance.
 * @tags Scheduler
 */
@BasePath('scheduler')
export class MaintenanceController extends SchedulerControllerBase {
  /**
   * Prune scheduler data
   * Removes orphaned schedules, plus runs, logs and resolved errors past retention.
   * @security cookieAuth
   * @returns {PruneResult} Number of removed records per kind
   * @response 401 Unauthorized — authenticated caller required
   * @response 403 Forbidden — scheduler:manage required
   */
  @Post('prune')
  @Access(SCHEDULER_MANAGE)
  public async prune() {
    return new Ok(await this.Scheduler.prune({ triggeredBy: this.triggeredBy() }));
  }
}
