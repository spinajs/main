import { BasePath, Get, Ok, Param, Policy } from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';

import { SchedulerControllerBase } from '../scheduler-controller.js';
import { SCHEDULER_READ, SCHEDULER_RESOURCE } from '../permissions.js';

/**
 * Scheduler schedules: definitions, health, manual runs, pause control and live events.
 * @tags Scheduler
 */
@BasePath('scheduler/schedules')
@Policy(AuthorizedPolicy)
@Resource(SCHEDULER_RESOURCE, SCHEDULER_READ)
export class SchedulesController extends SchedulerControllerBase {
  /**
   * List schedules
   * Every schedule with its spec, next run, pause state, health and last run.
   * @security cookieAuth
   * @returns {ScheduleInfo[]} Schedules
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny on the scheduler resource required
   */
  @Get('/')
  @Permission(SCHEDULER_READ)
  public async list() {
    return new Ok(await this.Scheduler.listSchedules());
  }

  /**
   * Show a schedule
   * Definition, health, recent runs and open error groups of one schedule.
   * @security cookieAuth
   * @param name Schedule name
   * @returns {ScheduleDetail} Schedule details
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny on the scheduler resource required
   * @response 404 Schedule not found
   */
  @Get(':name')
  @Permission(SCHEDULER_READ)
  public async show(@Param() name: string) {
    return new Ok(await this.Scheduler.getSchedule(name));
  }
}
