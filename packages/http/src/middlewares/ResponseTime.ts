import { Request, Response, NextFunction } from 'express';
import { ParamsDictionary } from 'express-serve-static-core';
import { ParsedQs } from 'qs';
import { ServerMiddleware, Request as sRequest } from '../interfaces.js';
import * as express from 'express';
import { Injectable } from '@spinajs/di';

@Injectable(ServerMiddleware)
export class ResponseTime extends ServerMiddleware {
  constructor() {
    super();
    // Must sit ABOVE Compression (Order 0): the timing header is written from a
    // res.end patch, and compression also patches res.end and flushes the
    // headers. Whichever patch is applied last runs first (outermost), so we
    // need a higher Order than compression to set our header before compression
    // sends it. Same tier as the other end-of-response instrumentation
    // (ServerTiming / AccessLog). The sub-millisecond difference in when the
    // start timestamp is taken is irrelevant for a response-time metric.
    this.Order = 2;
  }

  public after(): null {
    // Timing is finalised via a res.end patch in before() instead. After()
    // handlers do NOT run for matched controller routes (the response is
    // flushed inside the controllers router without calling next()), so the
    // x-response-time header set here would be dropped on every real response.
    return null;
  }

  public before(): (_req: Request<ParamsDictionary, any, any, ParsedQs, Record<string, any>>, res: Response<any, Record<string, any>>, next: NextFunction) => void {
    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      const start = new Date();
      req.storage.responseStart = start;

      // Finalise timing and write the header just before the response is
      // flushed, regardless of how the controller ended it. Headers are still
      // mutable here because the original res.end hasn't run yet.
      const originalEnd = res.end.bind(res) as typeof res.end;
      (res.end as any) = function patchedEnd(this: express.Response, ...args: any[]) {
        const end = new Date();
        req.storage.responseEnd = end;
        req.storage.responseTime = end.getTime() - start.getTime();
        if (!res.headersSent) {
          res.setHeader('x-response-time', String(req.storage.responseTime));
        }
        return originalEnd(...args);
      };

      next();
    };
  }
}
