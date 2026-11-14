import { v4 as uuidv4 } from 'uuid';
import { Injectable } from '@spinajs/di';
import { ROOT_CONTEXT } from '@opentelemetry/api';
import { activeTraceIds, childTraceIds, extractTraceContext, traceparentOf } from '@spinajs/tracing';

import { ServerMiddleware } from '../interfaces.js';
import type { IMiddlewareContext } from '../interfaces.js';

/**
 * `req.storage.requestId` and the `x-request-id` header; seeds `traceId`/`spanId` on `req.storage` from the active
 * server span and sends the outbound `traceparent`.
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

    // The server span of TracingMiddleware; without one ( tracing.enabled false, a bare unit test ) the ids are
    // minted here, continuing an inbound traceparent, unsampled like id-only mode since nothing records them.
    const ids = activeTraceIds() ?? childTraceIds(extractTraceContext(req.headers, ROOT_CONTEXT));
    storage.traceId = ids.traceId;
    storage.spanId = ids.spanId;
    res.header('traceparent', traceparentOf(ids));
  }
}
