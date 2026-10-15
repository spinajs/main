import { BasePath, Body, Get, Ok, Param, Patch, Policy, Query } from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';
import type { ErrorGroupStatus } from '@spinajs/scheduler';

import { compact, SchedulerControllerBase } from '../scheduler-controller.js';
import { SCHEDULER_MANAGE, SCHEDULER_READ, SCHEDULER_RESOURCE } from '../permissions.js';
import { ERROR_GROUP_STATUSES, ErrorStatusDto } from '../dto/requests.js';

/**
 * Scheduler error groups: errors grouped by fingerprint with counts and first / last seen.
 * @tags Scheduler
 */
@BasePath('scheduler/errors')
@Policy(AuthorizedPolicy)
@Resource(SCHEDULER_RESOURCE, SCHEDULER_READ)
export class ErrorsController extends SchedulerControllerBase {
  /**
   * List error groups
   * @security cookieAuth
   * @param schedule Only groups of this schedule
   * @param status Only groups in this status
   * @returns {ErrorGroupInfo[]} Error groups
   * @response 400 Invalid filter
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny on the scheduler resource required
   */
  @Get('/')
  @Permission(SCHEDULER_READ)
  public async list(@Query({ type: 'string', minLength: 1 }) schedule?: string, @Query({ type: 'string', enum: ERROR_GROUP_STATUSES }) status?: ErrorGroupStatus) {
    return new Ok(await this.Scheduler.listErrors(compact({ schedule, status })));
  }

  /**
   * Change the status of an error group
   * Resolve, ignore or reopen a group. A resolved group that occurs again reopens on its own.
   * @security cookieAuth
   * @param fingerprint Error group fingerprint
   * @returns {ErrorGroupInfo} Updated error group
   * @response 400 Invalid body
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny on the scheduler resource required
   * @response 404 Error group not found
   */
  @Patch(':fingerprint')
  @Permission(SCHEDULER_MANAGE)
  public async setStatus(@Param({ type: 'string', minLength: 1, maxLength: 128 }) fingerprint: string, @Body({ required: true }) body: ErrorStatusDto) {
    return new Ok(await this.Scheduler.setErrorStatus(fingerprint, body.status, { triggeredBy: this.triggeredBy() }));
  }
}
