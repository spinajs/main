import { Response, NextFunction } from 'express';
import * as express from 'express';
import { Injectable } from '@spinajs/di';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { ATTR_ERROR_TYPE, ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_URL_PATH, ATTR_URL_SCHEME } from '@opentelemetry/semantic-conventions';
import { extractTraceContext, tracer } from '@spinajs/tracing';

import { ServerMiddleware, Request as sRequest } from '../interfaces.js';
import { trackServerSpan } from '../tracing.js';

function endServerSpan(span: Span, res: express.Response): void {
  span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, res.statusCode);
  if (!res.writableFinished) {
    span.setAttribute(ATTR_ERROR_TYPE, 'aborted');
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'connection closed before the response finished' });
  } else if (res.statusCode >= 500) {
    span.setAttribute(ATTR_ERROR_TYPE, String(res.statusCode));
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
  span.end();
}

@Injectable(ServerMiddleware)
export class TracingMiddleware extends ServerMiddleware {
  constructor() {
    super();
    // Before ReqStorage (-2), so the server span covers every ServerMiddleware and RequestId (1) reads its ids.
    // `http.middlewares` (body parsers) are mounted before all ServerMiddleware and stay outside the span.
    this.Order = -3;
  }

  public after(): null {
    return null;
  }

  public before(): (req: sRequest, res: Response, next: NextFunction) => void {
    return (req: sRequest, res: express.Response, next: express.NextFunction) => {
      const parent = extractTraceContext(req.headers, ROOT_CONTEXT);
      const span = tracer().startSpan(
        req.method,
        { kind: SpanKind.SERVER, attributes: { [ATTR_HTTP_REQUEST_METHOD]: req.method, [ATTR_URL_PATH]: req.path, [ATTR_URL_SCHEME]: req.protocol } },
        parent,
      );
      trackServerSpan(req, span);

      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        endServerSpan(span, res);
      };
      res.once('finish', end);
      res.once('close', end);

      const active = trace.setSpan(parent, span);
      // Listeners on req/res (multipart parsers, finish hooks) would otherwise run in the socket's context.
      context.bind(active, req);
      context.bind(active, res);
      context.with(active, next);
    };
  }
}
