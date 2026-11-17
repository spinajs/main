import { Autoinject } from '@spinajs/di';
import { Access } from '@spinajs/authz-http';
import { BaseController, BasePath, Get, Ok, Param, Query } from '@spinajs/http';
import { isWorkflowStatus, WorkflowNotFound, WorkflowService } from '@spinajs/workflow';

import { DEFAULT_PAGE_SIZE, INSTANCE_ID_SCHEMA, MAX_PAGE_SIZE, STATUS_LIST_SCHEMA, WORKFLOW_NAME_SCHEMA } from '../dto.js';
import { WORKFLOW_READ, WORKFLOW_READ_PAYLOAD } from '../permissions.js';
import { overviewOf, summaryOf } from '../views.js';
// The controller scan imports this file, and an app may never import the package entry: this registers the error mappings.
import '../errors.js';

/**
 * Workflow instances: list and inspect.
 * @tags Workflow
 */
@BasePath('workflow/instances')
export class WorkflowInstancesController extends BaseController {
  @Autoinject(WorkflowService)
  protected Workflows: WorkflowService;

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
}
