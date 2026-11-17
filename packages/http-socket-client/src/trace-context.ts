import { context, propagation } from '@opentelemetry/api';

/** The active span as a W3C traceparent; undefined when no propagator is registered (a browser without an OTel SDK). */
export function activeTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
