import { BasePath, Get, Ok, Param, Policy, Query } from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';
import type { RunStatus, RunTrigger } from '@spinajs/scheduler';

import { compact, SchedulerControllerBase } from '../scheduler-controller.js';
import { SCHEDULER_READ, SCHEDULER_RESOURCE } from '../permissions.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, RUN_ID_SCHEMA, RUN_STATUSES, RUN_TRIGGERS } from '../dto/requests.js';

/**
 * Scheduler runs: history, details, live events, cancel and retry.
 * @tags Scheduler
 */
@BasePath('scheduler/runs')
@Policy(AuthorizedPolicy)
@Resource(SCHEDULER_RESOURCE, SCHEDULER_READ)
export class RunsController extends SchedulerControllerBase {
  /**
   * List runs
   * Newest first, paginated with limit and offset.
   * @security cookieAuth
   * @param schedule Only runs of this schedule
   * @param status Only runs in this status
   * @param trigger Only runs started by this trigger
   * @param from Only runs created at or after this instant ( ISO 8601 )
   * @param to Only runs created at or before this instant ( ISO 8601 )
   * @param limit Page size, default 50, at most 500
   * @param offset Number of runs to skip, default 0
   * @returns {Page} Runs on the requested page with the total count
   * @response 400 Invalid filter
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny on the scheduler resource required
   */
  @Get('/')
  @Permission(SCHEDULER_READ)
  public async list(
    @Query({ type: 'string', minLength: 1 }) schedule?: string,
    @Query({ type: 'string', enum: RUN_STATUSES }) status?: RunStatus,
    @Query({ type: 'string', enum: RUN_TRIGGERS }) trigger?: RunTrigger,
    @Query({ type: 'string', format: 'date-time' }) from?: string,
    @Query({ type: 'string', format: 'date-time' }) to?: string,
    @Query({ type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }) limit?: number,
    @Query({ type: 'integer', minimum: 0 }) offset?: number,
  ) {
    return new Ok(await this.Scheduler.listRuns(compact({ schedule, status, trigger, from, to, limit: limit ?? DEFAULT_PAGE_SIZE, offset: offset ?? 0 })));
  }

  /**
   * Show a run
   * Status, attempt chain, progress, current step and message, steps with timing, result, error and log lines.
   * @security cookieAuth
   * @param id Run id
   * @returns {RunDetail} Run details
   * @response 400 Malformed run id
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny on the scheduler resource required
   * @response 404 Run not found
   */
  @Get(':id')
  @Permission(SCHEDULER_READ)
  public async show(@Param(RUN_ID_SCHEMA) id: string) {
    return new Ok(await this.Scheduler.getRun(id));
  }
}
