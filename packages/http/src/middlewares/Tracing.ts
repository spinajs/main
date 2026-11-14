import { Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import type { Context, Span } from '@opentelemetry/api';
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_REQUEST_METHOD_ORIGINAL,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
  HTTP_REQUEST_METHOD_VALUE_OTHER,
} from '@opentelemetry/semantic-conventions';
import { SpinaAttr, extractTraceContext, tracer } from '@spinajs/tracing';

import { ServerMiddleware } from '../interfaces.js';
import type { IFinishContext, IMiddlewareContext, IRouteOutcome } from '../interfaces.js';
import { RouteClientGone } from '../exceptions.js';
import { routeErrorOf } from '../errors/on-error.js';
import { answeredErrorOf } from '../reply-pipeline.js';

// semconv: any other method is recorded as _OTHER, so a client cannot mint span names
const KNOWN_METHODS: ReadonlySet<string> = new Set(['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'QUERY', 'TRACE']);

/**
 * The SERVER span of a request: continues an inbound W3C `traceparent`, is the active span for every later server
 * middleware, the route and the reply, and is named after the route template the request matched when it finishes.
 */
@Injectable(ServerMiddleware)
export class TracingMiddleware extends ServerMiddleware {
  @Logger('http')
  protected Log!: Log;

  private readonly spans = new WeakMap<object, { span: Span; method: string }>();

  constructor() {
    super();
    // First of the server middlewares, so the span covers all of them and RequestId (1) reads its ids.
    // `http.bodyLimits` and `http.middlewares` (body parsers) are mounted before every server middleware and stay outside it.
    this.Order = -3;
  }

  public async onAround({ req, res }: IMiddlewareContext, proceed: () => Promise<IRouteOutcome>): Promise<void> {
    let active: Context | undefined;
    try {
      const known = KNOWN_METHODS.has(req.method);
      const method = known ? req.method : 'HTTP';
      const parent = extractTraceContext(req.headers, ROOT_CONTEXT);
      const span = tracer().startSpan(
        method,
        {
          kind: SpanKind.SERVER,
          attributes: {
            [ATTR_HTTP_REQUEST_METHOD]: known ? req.method : HTTP_REQUEST_METHOD_VALUE_OTHER,
            ...(known ? {} : { [ATTR_HTTP_REQUEST_METHOD_ORIGINAL]: req.method }),
            [ATTR_URL_PATH]: req.path,
            [ATTR_URL_SCHEME]: req.protocol,
          },
        },
        parent,
      );
      this.spans.set(res, { span, method });

      active = trace.setSpan(parent, span);
      // Listeners on req/res (multipart parsers, finish hooks) would otherwise run in the socket's context.
      context.bind(active, req);
      context.bind(active, res);
    } catch (error) {
      // a failing propagator or sampler of an external SDK must not fail the request
      this.Log.error({ error }, 'Tracing could not start the server span; the request runs untraced');
    }

    try {
      await (active ? context.with(active, proceed) : proceed());
    } catch (err) {
      // onFinish ends the span of a request the client left
      if (!(err instanceof RouteClientGone)) {
        throw err;
      }
    }
  }

  public onFinish({ res, path, aborted }: IFinishContext): void {
    const entry = this.spans.get(res);
    if (!entry) {
      return;
    }
    this.spans.delete(res);
    const { span, method } = entry;

    if (path) {
      // `path` is `http:<METHOD> <mounted path>`
      const template = path.slice(path.indexOf(' ') + 1);
      span.updateName(`${method} ${template}`);
      span.setAttribute(ATTR_HTTP_ROUTE, template);
    }

    if (aborted && !res.headersSent) {
      // no status code went out; the unsent default would read as a 200
      span.setAttribute(ATTR_ERROR_TYPE, 'aborted');
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'connection closed before the response was sent' });
      span.end();
      return;
    }

    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, res.statusCode);
    if (aborted) {
      // a streamed reply the client closed after its status line: the status stands, the abort is not an error
      span.setAttribute(SpinaAttr.HttpAborted, true);
    }
    if (res.statusCode >= 500) {
      span.setAttribute(ATTR_ERROR_TYPE, String(res.statusCode));
      span.setStatus({ code: SpanStatusCode.ERROR });
      const error = routeErrorOf(res) ?? answeredErrorOf(res);
      if (error !== undefined) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
      }
    }
    span.end();
  }
}
