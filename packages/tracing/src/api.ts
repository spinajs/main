import { createRequire } from 'node:module';
import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, context, defaultTextMapGetter, defaultTextMapSetter, isSpanContextValid, propagation, trace } from '@opentelemetry/api';
import type { Context, Span, SpanContext, SpanOptions, Tracer, TracerProvider } from '@opentelemetry/api';
import { RandomIdGenerator } from '@opentelemetry/sdk-trace-base';

import { W3C_PROPAGATOR, W3C_TRACE_CONTEXT } from './propagator.js';

export const TRACER_NAME = '@spinajs';
export const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

export interface TraceIds {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

const IDS = new RandomIdGenerator();

// trace.getTracer() builds a cache key on every call (about as costly as an id-only span). The global proxy is
// replaced only by trace.disable(), and a tracer taken before registration delegates once a provider is set.
let cached: { provider: TracerProvider; tracer: Tracer } | undefined;

export function tracer(): Tracer {
  const provider = trace.getTracerProvider();
  if (cached?.provider !== provider) {
    cached = { provider, tracer: provider.getTracer(TRACER_NAME, VERSION) };
  }
  return cached.tracer;
}

export function markSpanError(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
}

export async function withSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
  const span = tracer().startSpan(name, options);
  try {
    return await context.with(trace.setSpan(context.active(), span), fn, undefined, span);
  } catch (err) {
    markSpanError(span, err);
    throw err;
  } finally {
    span.end();
  }
}

// Without a registered propagator (tracing disabled, a unit test) the API propagator is a no-op; W3C keeps
// traceparent flowing anyway. A registered one (ours or an external SDK's) always wins.
const globalPropagator = (): boolean => propagation.fields().length > 0;

export function injectTraceContext(carrier: Record<string, string>, ctx: Context = context.active()): void {
  if (globalPropagator()) {
    propagation.inject(ctx, carrier);
  } else {
    W3C_PROPAGATOR.inject(ctx, carrier, defaultTextMapSetter);
  }
}

export function extractTraceContext(carrier: Record<string, string | string[] | undefined>, base: Context = context.active()): Context {
  return globalPropagator() ? propagation.extract(base, carrier) : W3C_PROPAGATOR.extract(base, carrier, defaultTextMapGetter);
}

const isSampled = (sc: SpanContext): boolean => (sc.traceFlags & TraceFlags.SAMPLED) !== 0;

export function activeTraceIds(): TraceIds | undefined {
  const sc = trace.getActiveSpan()?.spanContext();
  if (!sc || sc.isRemote || !isSpanContextValid(sc)) return undefined;
  return { traceId: sc.traceId, spanId: sc.spanId, sampled: isSampled(sc) };
}

// Never sampled: nothing records without a span, which is what HubSampler answers with an empty hub, so a caller
// sees trace-flags 00 whether tracing is disabled or id-only (program decision 1, keep E4).
export function childTraceIds(parent: Context): TraceIds {
  const sc = trace.getSpanContext(parent);
  if (sc && isSpanContextValid(sc)) {
    return { traceId: sc.traceId, spanId: IDS.generateSpanId(), sampled: false };
  }
  return { traceId: IDS.generateTraceId(), spanId: IDS.generateSpanId(), sampled: false };
}

export function traceparentOf(ids: TraceIds): string {
  const carrier: Record<string, string> = {};
  const sc: SpanContext = { traceId: ids.traceId, spanId: ids.spanId, traceFlags: ids.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE };
  W3C_TRACE_CONTEXT.inject(trace.setSpanContext(ROOT_CONTEXT, sc), carrier, defaultTextMapSetter);
  return carrier.traceparent;
}
