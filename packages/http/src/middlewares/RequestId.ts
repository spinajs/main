import { Response, NextFunction } from 'express';
import { ServerMiddleware, Request as sRequest } from '../interfaces.js';
import * as express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Injectable } from '@spinajs/di';
import { newTraceContext, formatTraceparent, ITraceContext } from '@spinajs/log';

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

      // Continue an inbound W3C traceparent ( or start a new trace ) and seed
      // traceId / spanId onto req.storage so the ambient log context merges them
      // into every log line — trace ids are shared across services.
      const tc: ITraceContext = newTraceContext(req.headers['traceparent'] as string | undefined);
      req.storage.traceId = tc.traceId;
      req.storage.spanId = tc.spanId;

      // Emit the outbound traceparent here ( not in after() ) because the
      // `sampled` flag lives on this freshly-computed context and req.storage —
      // typed as the public IActionLocalStoregeContext — deliberately does not
      // carry it. Setting a response header before next() is safe as long as the
      // response has not been sent, mirroring x-request-id.
      res.header('traceparent', formatTraceparent(tc));

      next();
    };
  }
}
