import { BasePath, Body, Get, HTTP_STATUS_CODE, Ok, Param, Policy, Post } from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';

import { SchedulerControllerBase } from '../scheduler-controller.js';
import { SCHEDULER_MANAGE, SCHEDULER_READ, SCHEDULER_RESOURCE, SCHEDULER_RUN } from '../permissions.js';
import { PauseDto, RetryFailedDto, RunNowDto } from '../dto/requests.js';

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

  /**
   * Run a schedule now
   * Validates `params` against the schedule's parameter schema and queues a manual run that records the
   * caller as `triggeredBy`. A run in progress answers 409 with its id; with `force` the run is queued
   * behind it instead. With `wait` the request is held until the run ends and answers 200 with the run.
   * @security cookieAuth
   * @param name Schedule name
   * @returns {ISchedulerRunAccepted} Run id and the run, when the request waited
   * @response 202 {ISchedulerRunAccepted} Run queued
   * @response 400 Invalid body, or params rejected by the schedule's schema
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny on the scheduler resource required
   * @response 404 Schedule not found
   * @response 409 A run is in progress ( body carries its runId ), or the schedule is hard-paused
   */
  @Post(':name/runs')
  @Permission(SCHEDULER_RUN)
  public async runNow(@Param() name: string, @Body() body: RunNowDto) {
    const dto = body ?? new RunNowDto();
    const result = await this.Scheduler.runNow(name, {
      params: dto.params,
      force: dto.force ?? false,
      wait: dto.wait ?? false,
      triggeredBy: this.triggeredBy(),
    });

    return result.run ? new Ok(result) : new Ok(result, { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }

  /**
   * Retry all failed runs
   * Queues one retry per failed or dead run of the schedule that finished at or after `since` and has no retry yet,
   * oldest first, executed one at a time.
   * @security cookieAuth
   * @param name Schedule name
   * @response 202 Retries queued; the body lists their run ids
   * @response 400 Missing or invalid since
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny on the scheduler resource required
   * @response 404 Schedule not found
   */
  @Post(':name/retry-failed')
  @Permission(SCHEDULER_RUN)
  public async retryFailed(@Param() name: string, @Body({ required: true }) body: RetryFailedDto) {
    const result = await this.Scheduler.retryFailed(name, body.since, { triggeredBy: this.triggeredBy() });
    return new Ok(result, { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }

  /**
   * Pause a schedule
   * Stops new scheduled runs. Manual runs still work unless `hard` is set.
   * @security cookieAuth
   * @param name Schedule name
   * @returns {ScheduleInfo} The paused schedule
   * @response 400 Invalid body
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny on the scheduler resource required
   * @response 404 Schedule not found
   */
  @Post(':name/pause')
  @Permission(SCHEDULER_MANAGE)
  public async pause(@Param() name: string, @Body() body: PauseDto) {
    return new Ok(await this.Scheduler.pause(name, { hard: body?.hard ?? false, triggeredBy: this.triggeredBy() }));
  }

  /**
   * Resume a schedule
   * Clears a manual or failure-triggered pause and resets the consecutive-failure count.
   * @security cookieAuth
   * @param name Schedule name
   * @returns {ScheduleInfo} The resumed schedule
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — deleteAny on the scheduler resource required
   * @response 404 Schedule not found
   */
  @Post(':name/resume')
  @Permission(SCHEDULER_MANAGE)
  public async resume(@Param() name: string) {
    return new Ok(await this.Scheduler.resume(name, { triggeredBy: this.triggeredBy() }));
  }
}
