import { ROOT_CONTEXT, SpanKind, context, isSpanContextValid, trace } from '@opentelemetry/api';
import type { Attributes, Context, Link, Span, SpanOptions } from '@opentelemetry/api';
import { extractTraceContext, injectTraceContext, markSpanErrorType, withSpan } from '@spinajs/tracing';

import { QueueHeaders } from './headers.js';
import type { IQueueMessage } from './interfaces.js';

// Not a semconv well-known value: the transport is per connection and one emit may reach several.
const MESSAGING_SYSTEM = 'spinajs';

const TRACE_HEADERS: ReadonlySet<string> = new Set([QueueHeaders.TraceParent, QueueHeaders.TraceState, 'baggage']);

function messagingAttributes(message: IQueueMessage, operationType: string, operationName: string): Attributes {
  return {
    'messaging.system': MESSAGING_SYSTEM,
    'messaging.operation.type': operationType,
    'messaging.operation.name': operationName,
    'messaging.destination.name': message.Name,
    ...(message.MessageId ? { 'messaging.message.id': message.MessageId } : {}),
  };
}

function withPublishSpan<T>(message: IQueueMessage, options: Pick<SpanOptions, 'root' | 'links'>, send: (span: Span) => Promise<T>): Promise<T> {
  return withSpan(`publish ${message.Name}`, { ...options, kind: SpanKind.PRODUCER, attributes: messagingAttributes(message, 'send', 'publish') }, send, markSpanErrorType);
}

/** The span context `message.Headers` carry, as a link; none when they hold no valid one. */
function linksToOrigin(message: IQueueMessage): Link[] {
  const origin = trace.getSpanContext(extractTraceContext(message.Headers ?? {}, ROOT_CONTEXT));
  return origin ? [{ context: origin }] : [];
}

/** Runs `send` under a PRODUCER span `publish <Name>`, child of `parent`, and writes that span's trace context into `message.Headers`. */
export function withProducerSpan<T>(message: IQueueMessage, parent: Context, send: (span: Span) => Promise<T>): Promise<T> {
  return context.with(parent, () =>
    withPublishSpan(message, {}, (span) => {
      // With tracing off the span has no ids and the headers the caller set stay. Otherwise a received message
      // emitted again would carry the old trace; the new span replaces it.
      if (isSpanContextValid(span.spanContext())) {
        const headers = Object.fromEntries(Object.entries(message.Headers ?? {}).filter(([name]) => !TRACE_HEADERS.has(name)));
        // the span is named, not read from context.active(): without a registered context manager the active context has no span
        injectTraceContext(headers, trace.setSpan(context.active(), span));
        message.Headers = headers;
      }
      return send(span);
    }),
  );
}

/**
 * Runs the outbox relay's `send` of a stored message under a PRODUCER span `publish <Name>`: a new trace linked to the
 * context in `message.Headers`. The headers stay as stored, so the consumer remains a child of the emit's `create` span.
 */
export function withRelayPublishSpan<T>(message: IQueueMessage, send: () => Promise<T>): Promise<T> {
  // root even when a caller drives tick() inside its own trace: the publish belongs to no caller
  return withPublishSpan(message, { root: true, links: linksToOrigin(message) }, send);
}

/** Turns a producer span into `create <Name>`: the emit wrote an outbox row and the relay publishes later. */
export function markOutboxCreate(span: Span, message: IQueueMessage): void {
  span.updateName(`create ${message.Name}`);
  span.setAttributes({ 'messaging.operation.type': 'create', 'messaging.operation.name': 'create' });
}

const positive = (value: number | undefined): boolean => typeof value === 'number' && value > 0;

/** A delayed, repeating or cron message: `ScheduleCron` set, or `ScheduleDelay`, `SchedulePeriod` or `ScheduleRepeat` above 0. */
export function isScheduledDelivery(message: IQueueMessage): boolean {
  return Boolean(message.ScheduleCron) || positive(message.ScheduleDelay) || positive(message.SchedulePeriod) || positive(message.ScheduleRepeat);
}

/** Runs `handle` under a CONSUMER span: a child of the trace in `message.Headers`, or for a scheduled delivery a new trace linked to it. */
export function withConsumerSpan<T>(message: IQueueMessage, handle: () => Promise<T>): Promise<T> {
  const name = `process ${message.Name}`;
  const attributes = messagingAttributes(message, 'process', 'process');

  if (!isScheduledDelivery(message)) {
    const origin = extractTraceContext(message.Headers ?? {}, ROOT_CONTEXT);
    return context.with(origin, () => withSpan(name, { kind: SpanKind.CONSUMER, attributes }, handle, markSpanErrorType));
  }

  // a scheduled delivery outlives the trace that scheduled it, and a repeating one would make that trace endless
  return withSpan(name, { kind: SpanKind.CONSUMER, attributes, root: true, links: linksToOrigin(message) }, handle, markSpanErrorType);
}
