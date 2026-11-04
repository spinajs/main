import { Response, NextFunction } from 'express';
import { ServerMiddleware, Request as sRequest } from '../interfaces.js';
import * as express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Injectable } from '@spinajs/di';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { activeTraceIds, childTraceIds, extractTraceContext, traceparentOf } from '@spinajs/tracing';

@Injectable(ServerMiddleware)
export class RequestId extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  public after(): null {
    // The x-request-id header is set in before() instead. ServerMiddleware
    // after() handlers do NOT run for matched controller routes (the response
    // is flushed inside the controllers router without calling next()), so
    // setting the header here would silently drop it on every real response.
    return null;
  }

  public before(): (req: sRequest, res: Response<any, Record<string, any>>, next: NextFunction) => void {
    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      req.storage.requestId = uuidv4();

      // Emitted here, not in after(): ServerMiddleware after() handlers never
      // run for matched controller routes ( response is flushed inside the
      // controllers router without calling next() ).
      res.header('x-request-id', req.storage.requestId);

      // The server span of TracingMiddleware; without one ( tracing.enabled false, a bare unit test ) the ids are
      // minted here, continuing an inbound traceparent, unsampled like id-only mode since nothing records them.
      const ids = activeTraceIds() ?? childTraceIds(extractTraceContext(req.headers, ROOT_CONTEXT));
      req.storage.traceId = ids.traceId;
      req.storage.spanId = ids.spanId;
      res.header('traceparent', traceparentOf(ids));

      next();
    };
  }
}
