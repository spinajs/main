import { v4 as uuidv4 } from 'uuid';
import { Injectable } from '@spinajs/di';
import { newTraceContext, formatTraceparent, ITraceContext } from '@spinajs/log';

import { ServerMiddleware } from '../interfaces.js';
import type { IMiddlewareContext } from '../interfaces.js';

/**
 * `req.storage.requestId` and the `x-request-id` header; continues an inbound W3C `traceparent` (or starts a trace),
 * seeds `traceId`/`spanId` on `req.storage` and sends the outbound `traceparent`.
 */
@Injectable(ServerMiddleware)
export class RequestId extends ServerMiddleware {
  constructor() {
    super();
    this.Order = 1;
  }

  // Headers set here, not in onAfter, so static files and replies an action writes itself carry them too.
  public onBefore({ req, res, storage }: IMiddlewareContext): void {
    storage.requestId = uuidv4();
    res.header('x-request-id', storage.requestId);

    const tc: ITraceContext = newTraceContext(req.headers['traceparent'] as string | undefined);
    storage.traceId = tc.traceId;
    storage.spanId = tc.spanId;

    // The `sampled` flag lives on this context only: req.storage deliberately does not carry it.
    res.header('traceparent', formatTraceparent(tc));
  }
}
