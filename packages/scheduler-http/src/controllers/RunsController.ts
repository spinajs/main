import { BasePath, Body, Get, Header, HTTP_STATUS_CODE, Ok, Param, Policy, Post, Query, SseResponse } from '@spinajs/http';
import { AuthorizedPolicy, Permission, Resource } from '@spinajs/rbac-http';
import { parseSseEventId } from '@spinajs/scheduler';
import type { RunStatus, RunTrigger } from '@spinajs/scheduler';

import { compact, SchedulerControllerBase } from '../scheduler-controller.js';
import { SCHEDULER_READ, SCHEDULER_RESOURCE, SCHEDULER_RUN } from '../permissions.js';
import { DEFAULT_PAGE_SIZE, LAST_EVENT_ID_SCHEMA, MAX_PAGE_SIZE, RetryRunDto, RUN_ID_SCHEMA, RUN_STATUSES, RUN_TRIGGERS } from '../dto/requests.js';
import { streamRunEvents } from '../sse/run-events.js';

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

  /**
   * Cancel a run
   * Requests cancellation. The replica holding the run aborts it on its next heartbeat and the run
   * ends `aborted` with reason `cancelled`.
   * @security cookieAuth
   * @param id Run id
   * @response 202 {RunInfo} Cancellation requested; the run as it is now
   * @response 400 Malformed run id
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny on the scheduler resource required
   * @response 404 Run not found
   * @response 409 The run already ended
   */
  @Post(':id/cancel')
  @Permission(SCHEDULER_RUN)
  public async cancel(@Param(RUN_ID_SCHEMA) id: string) {
    return new Ok(await this.Scheduler.cancel(id, { triggeredBy: this.triggeredBy() }), { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }

  /**
   * Retry a run
   * Allowed for failed, dead and aborted runs. Creates a new run with trigger `retry`, linked to this
   * one. With `resume` ( default: the schedule's `resumable` ) the retry reuses the last checkpoint and
   * skips completed steps, or starts at `fromStep`.
   * @security cookieAuth
   * @param id Run id
   * @response 202 {ISchedulerRunAccepted} Retry queued
   * @response 400 Malformed run id or body
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — updateAny on the scheduler resource required
   * @response 404 Run not found
   * @response 409 The run is not in a retryable state
   */
  @Post(':id/retry')
  @Permission(SCHEDULER_RUN)
  public async retry(@Param(RUN_ID_SCHEMA) id: string, @Body() body: RetryRunDto) {
    const dto = body ?? new RetryRunDto();
    const result = await this.Scheduler.retry(id, {
      ...compact({ fromStep: dto.fromStep, params: dto.params, resume: dto.resume }),
      triggeredBy: this.triggeredBy(),
    });

    return new Ok(result, { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }

  /**
   * Live run events
   * Server-Sent Events stream of the run: `status`, `step-start`, `step-end`, `progress`, `message`, `log`
   * and `error`. Every event carries `id: <seq>`. Without `Last-Event-ID` the stream starts with the run's
   * history; with it, only the missed events are replayed. A `: ping` comment is sent every
   * `scheduler.http.sse.heartbeat` ms ( 15 s by default ). The stream ends after the terminal `status`
   * ( `succeeded`, `failed`, `dead`, `aborted`, `skipped`, `misfired` ); it stays open through `retrying`
   * and `emitted`, so one stream follows every automatic retry of the run.
   * Error statuses are only rendered when the client also accepts JSON
   * ( `Accept: text/event-stream, application/json;q=0.5` ), otherwise they answer 406.
   * @security cookieAuth
   * @param id Run id
   * @param lastEventId Seq of the last event the client received
   * @returns {SseResponse} Run event stream
   * @response 400 Malformed run id or Last-Event-ID
   * @response 401 Unauthorized — valid session required
   * @response 403 Forbidden — readAny on the scheduler resource required
   * @response 404 Run not found
   */
  @Get(':id/events')
  @Permission(SCHEDULER_READ)
  public async events(@Param(RUN_ID_SCHEMA) id: string, @Header('last-event-id', LAST_EVENT_ID_SCHEMA) lastEventId?: string) {
    const run = await this.Scheduler.getRun(id);
    const after = parseSseEventId(lastEventId) ?? 0;

    return new SseResponse((stream) => streamRunEvents(stream, this.Scheduler, run, after), { HeartbeatMs: this.HeartbeatMs });
  }
}
