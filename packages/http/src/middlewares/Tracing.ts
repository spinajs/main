import { Injectable } from '@spinajs/di';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { ATTR_ERROR_TYPE, ATTR_HTTP_REQUEST_METHOD, ATTR_HTTP_RESPONSE_STATUS_CODE, ATTR_HTTP_ROUTE, ATTR_URL_PATH, ATTR_URL_SCHEME } from '@opentelemetry/semantic-conventions';
import { extractTraceContext, tracer } from '@spinajs/tracing';

import { ServerMiddleware } from '../interfaces.js';
import type { IFinishContext, IMiddlewareContext, IRouteOutcome } from '../interfaces.js';
import { RouteClientGone } from '../exceptions.js';

/**
 * The SERVER span of a request: continues an inbound W3C `traceparent`, is the active span for every later server
 * middleware, the route and the reply, and is named after the route template the request matched.
 */
@Injectable(ServerMiddleware)
export class TracingMiddleware extends ServerMiddleware {
  private readonly spans = new WeakMap<object, Span>();

  constructor() {
    super();
    // First of the server middlewares, so the span covers all of them and RequestId (1) reads its ids.
    // `http.bodyLimits` and `http.middlewares` (body parsers) are mounted before every server middleware and stay outside it.
    this.Order = -3;
  }

  public async onAround({ req, res }: IMiddlewareContext, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    const parent = extractTraceContext(req.headers, ROOT_CONTEXT);
    const span = tracer().startSpan(
      req.method,
      { kind: SpanKind.SERVER, attributes: { [ATTR_HTTP_REQUEST_METHOD]: req.method, [ATTR_URL_PATH]: req.path, [ATTR_URL_SCHEME]: req.protocol } },
      parent,
    );
    this.spans.set(res, span);

    const active = trace.setSpan(parent, span);
    // Listeners on req/res (multipart parsers, finish hooks) would otherwise run in the socket's context.
    context.bind(active, req);
    context.bind(active, res);

    try {
      await context.with(active, proceed);
    } catch (err) {
      // onFinish ends the span of a request the client left
      if (!(err instanceof RouteClientGone)) {
        throw err;
      }
    }
  }

  public onFinish({ req, res, path, aborted }: IFinishContext): void {
    const span = this.spans.get(res);
    if (!span) {
      return;
    }
    this.spans.delete(res);

    if (path) {
      // `path` is `http:<METHOD> <mounted path>`
      const template = path.slice(path.indexOf(' ') + 1);
      span.updateName(`${req.method} ${template}`);
      span.setAttribute(ATTR_HTTP_ROUTE, template);
    }
    // an aborted request that sent nothing has only the default 200
    if (!aborted || res.headersSent) {
      span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, res.statusCode);
    }
    if (aborted) {
      span.setAttribute(ATTR_ERROR_TYPE, 'aborted');
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'connection closed before the response finished' });
    } else if (res.statusCode >= 500) {
      span.setAttribute(ATTR_ERROR_TYPE, String(res.statusCode));
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
    span.end();
  }
}
