import type { Span } from '@opentelemetry/api';
import { ATTR_HTTP_ROUTE } from '@opentelemetry/semantic-conventions';
import type Express from 'express';

const serverSpans = new WeakMap<object, Span>();

export function trackServerSpan(req: object, span: Span): void {
  serverSpans.set(req, span);
}

// The template is known only once Express matched the route, so the span started by TracingMiddleware is renamed here.
export function routeMarker(template: string): Express.RequestHandler {
  return (req, _res, next) => {
    const span = serverSpans.get(req);
    if (span) {
      span.updateName(`${req.method} ${template}`);
      span.setAttribute(ATTR_HTTP_ROUTE, template);
    }
    next();
  };
}
