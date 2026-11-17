import { Autoinject } from '@spinajs/di';
import { Access } from '@spinajs/authz-http';
import { BaseController, BasePath, Body, Get, HTTP_STATUS_CODE, Ok, Param, Post, Query } from '@spinajs/http';
import { isWorkflowStatus, WorkflowNotFound, WorkflowService } from '@spinajs/workflow';

import { CancelDto, DEFAULT_PAGE_SIZE, INSTANCE_ID_SCHEMA, MAX_PAGE_SIZE, SIGNAL_NAME_SCHEMA, SignalDto, StartWorkflowDto, STATUS_LIST_SCHEMA, WORKFLOW_NAME_SCHEMA } from '../dto.js';
import { WORKFLOW_MANAGE, WORKFLOW_READ, WORKFLOW_READ_PAYLOAD, WORKFLOW_SIGNAL } from '../permissions.js';
import { signalPrincipal } from '../principal.js';
import { overviewOf, summaryOf, type WorkflowInstanceSummary } from '../views.js';
// The controller scan imports this file, and an app may never import the package entry: this registers the error mappings.
import '../errors.js';

/**
 * Workflow instances: list, inspect, start, signal, cancel and retry.
 * @tags Workflow
 */
@BasePath('workflow/instances')
export class WorkflowInstancesController extends BaseController {
  @Autoinject(WorkflowService)
  protected Workflows: WorkflowService;

  protected async summary(id: string): Promise<WorkflowInstanceSummary> {
    const view = await this.Workflows.get(id);
    if (!view) throw new WorkflowNotFound(id);
    return summaryOf(view);
  }

  /**
   * List instances
   * Ordered by id, paginated with `after`: pass the `next` of the previous page. Items carry no input, result or error stack.
   * @param workflow Only instances of this workflow
   * @param status Comma-separated statuses
   * @param limit Page size, default 50, at most 500
   * @param after The last id of the previous page
   * @response 400 Invalid filter
   * @response 401 Unauthorized
   * @response 403 Forbidden — workflow:read required
   */
  @Get('/')
  @Access(WORKFLOW_READ)
  public async list(
    @Query(WORKFLOW_NAME_SCHEMA) workflow?: string,
    @Query(STATUS_LIST_SCHEMA) status?: string,
    @Query({ type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }) limit?: number,
    @Query(INSTANCE_ID_SCHEMA) after?: string,
  ) {
    const size = limit ?? DEFAULT_PAGE_SIZE;
    const items = await this.Workflows.list({
      limit: size,
      ...(workflow !== undefined ? { workflow } : {}),
      // the schema already admits only statuses; the guard gives the list its type
      ...(status !== undefined ? { status: status.split(',').filter(isWorkflowStatus) } : {}),
      ...(after !== undefined ? { after } : {}),
    });
    return new Ok({ items: items.map(summaryOf), next: items.length === size ? items[items.length - 1].id : null });
  }

  /**
   * Show an instance
   * Status, journal rows and pending signals. No input, no result, and of each error its name, message and step.
   * @param id Instance id
   * @response 401 Unauthorized
   * @response 403 Forbidden — workflow:read required
   * @response 404 Instance not found
   */
  @Get(':id')
  @Access(WORKFLOW_READ)
  public async show(@Param(INSTANCE_ID_SCHEMA) id: string) {
    const detail = await this.Workflows.details(id);
    if (!detail) throw new WorkflowNotFound(id);
    return new Ok(overviewOf(detail));
  }

  /**
   * Show an instance with its payloads
   * What the instance route shows, plus the input, the result and every error in full ( stack, details ).
   * @param id Instance id
   * @response 401 Unauthorized
   * @response 403 Forbidden — workflow:read-payload required
   * @response 404 Instance not found
   */
  @Get(':id/payload')
  @Access(WORKFLOW_READ_PAYLOAD)
  public async payload(@Param(INSTANCE_ID_SCHEMA) id: string) {
    const detail = await this.Workflows.details(id);
    if (!detail) throw new WorkflowNotFound(id);
    return new Ok(detail);
  }

  /**
   * Start an instance
   * Idempotent on `id`: a repeated start answers 200 with `created: false`.
   * @response 201 Started
   * @response 400 Invalid body or unknown workflow
   * @response 401 Unauthorized
   * @response 403 Forbidden — workflow:manage required
   * @response 409 The id belongs to another workflow
   */
  @Post('/')
  @Access(WORKFLOW_MANAGE)
  public async start(@Body({ required: true }) body: StartWorkflowDto) {
    const started = await this.Workflows.start(body.workflow, body.input ?? null, { ...(body.id !== undefined ? { id: body.id } : {}), ...(body.version !== undefined ? { version: body.version } : {}) });
    return new Ok(started, { StatusCode: started.created ? HTTP_STATUS_CODE.CREATED : HTTP_STATUS_CODE.OK });
  }

  /**
   * Signal an instance
   * Buffered until a `waitForEvent(name)` consumes it. A wait with a `permission` also checks the caller then.
   * `accepted: false` when the instance has ended or the `dedupKey` was used.
   * @param id Instance id
   * @param name Signal name
   * @response 202 Signal stored or refused
   * @response 400 Invalid name or body
   * @response 401 Unauthorized
   * @response 403 Forbidden — workflow:signal required, or a restricted credential
   * @response 404 Instance not found
   */
  @Post(':id/signals/:name')
  @Access(WORKFLOW_SIGNAL)
  public async signal(@Param(INSTANCE_ID_SCHEMA) id: string, @Param(SIGNAL_NAME_SCHEMA) name: string, @Body() body?: SignalDto) {
    const dto = body ?? new SignalDto();
    const principal = signalPrincipal(this._actionLocalStorage.getStore()?.Principal);
    const result = await this.Workflows.signal(id, name, dto.payload ?? null, { principal, ...(dto.dedupKey !== undefined ? { dedupKey: dto.dedupKey } : {}) });
    return new Ok(result, { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }

  /**
   * Cancel an instance
   * Running, sleeping and waiting instances end `cancelled` on their next activation; others are left alone.
   * @param id Instance id
   * @response 202 Cancellation requested; the instance as it is now
   * @response 401 Unauthorized
   * @response 403 Forbidden — workflow:manage required
   * @response 404 Instance not found
   */
  @Post(':id/cancel')
  @Access(WORKFLOW_MANAGE)
  public async cancel(@Param(INSTANCE_ID_SCHEMA) id: string, @Body() body?: CancelDto) {
    await this.Workflows.cancel(id, body?.reason);
    return new Ok(await this.summary(id), { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }

  /**
   * Retry a failed instance
   * Resumes from the failed step, or the failed compensation of a `compensation-failed` instance.
   * @param id Instance id
   * @response 202 Retry scheduled; the instance as it is now
   * @response 401 Unauthorized
   * @response 403 Forbidden — workflow:manage required
   * @response 404 Instance not found
   * @response 409 The instance is not failed, or passed its deadline
   */
  @Post(':id/retry')
  @Access(WORKFLOW_MANAGE)
  public async retry(@Param(INSTANCE_ID_SCHEMA) id: string) {
    await this.Workflows.retry(id);
    return new Ok(await this.summary(id), { StatusCode: HTTP_STATUS_CODE.ACCEPTED });
  }
}
