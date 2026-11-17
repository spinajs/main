import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

import type { StudioRoutes } from '../contracts/index.js';
import { StudioAccess } from '../policies/StudioAccessPolicy.js';
import { LimitQuery, OffsetCursorQuery } from '../queries/params.js';
import { RoutesService } from '../routes/service.js';

/** The default page is the largest one, so a client that does not page sees every route of any realistic app. */
export const MAX_ROUTE_LIMIT = 5000;

@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioRoutesController extends BaseController {
  @Autoinject(RoutesService)
  protected RouteCatalog: RoutesService;

  /**
   * Mounted routes with their guards, latency from the trace buffer and telemetry counts.
   *
   * @returns {StudioRoutes} The source used and one entry per route
   */
  @Get('api/routes')
  @StudioAccess('routes')
  public async list(@LimitQuery(MAX_ROUTE_LIMIT) limit?: number, @OffsetCursorQuery() cursor?: number) {
    const { source, data } = this.RouteCatalog.routes();
    const offset = cursor ?? 0;
    const end = offset + (limit ?? MAX_ROUTE_LIMIT);
    const page: StudioRoutes = { source, data: data.slice(offset, end), total: data.length, ...(end < data.length ? { cursor: String(end) } : {}) };
    return new Ok(page);
  }
}
