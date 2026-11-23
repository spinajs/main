import { Autoinject } from '@spinajs/di';
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';

import { LogStore } from '../buffers/log-store.js';
import type { StudioLogLine, StudioPage } from '../contracts/index.js';
import { StudioAccess } from '../policies/StudioAccessPolicy.js';
import { given } from '../queries/params.js';
import { LogQueryArg } from '../queries/traces.js';

@BasePath({ config: 'studio.path', default: '/_studio' })
export class StudioLogsController extends BaseController {
  @Autoinject(LogStore)
  protected Logs: LogStore;

  /**
   * Buffered log lines, newest first: those with a trace id, and warnings and above.
   *
   * @returns {StudioPage} Log lines
   */
  @Get('api/logs')
  @StudioAccess('logs')
  public async list(@LogQueryArg('traceId') traceId?: string, @LogQueryArg('level') level?: string, @LogQueryArg('limit') limit?: number) {
    const trace = given(traceId);
    const min = given(level);
    const page: StudioPage<StudioLogLine> = { items: this.Logs.query({ ...(trace ? { traceId: trace } : {}), ...(min ? { level: min } : {}), ...(limit === undefined ? {} : { limit }) }) };
    return new Ok(page);
  }
}
