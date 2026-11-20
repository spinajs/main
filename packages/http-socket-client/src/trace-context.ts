import { context, propagation } from '@opentelemetry/api';

/**
 * The active span as a W3C traceparent; undefined when no propagator is registered (a browser without an OTel SDK)
 * or when the registered one throws, so a broken SDK never fails a command.
 */
export function activeTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  try {
    propagation.inject(context.active(), carrier);
  } catch {
    return undefined;
  }
  return carrier.traceparent;
}
