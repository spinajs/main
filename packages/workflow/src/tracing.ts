import { ROOT_CONTEXT, SpanKind, context, trace } from '@opentelemetry/api';
import type { Link, Span } from '@opentelemetry/api';
import { SpinaAttr, activeTraceIds, extractTraceContext, markSpanErrorType, traceparentOf, tracer } from '@spinajs/tracing';

import type { WorkflowInstanceModel } from './models/WorkflowInstanceModel.js';

export function currentTraceParent(): string | null {
  const ids = activeTraceIds();
  return ids ? traceparentOf(ids) : null;
}

function linkTo(traceparent: string | null): Link[] {
  if (!traceparent) return [];
  const sc = trace.getSpanContext(extractTraceContext({ traceparent }, ROOT_CONTEXT));
  return sc ? [{ context: sc }] : [];
}

/** A root span per activation: activations run on the engine loop, after the start call returned. */
export async function withActivationSpan<T>(row: WorkflowInstanceModel, fn: (span: Span) => Promise<T>): Promise<T> {
  const span = tracer().startSpan(`workflow ${row.Workflow}`, {
    kind: SpanKind.INTERNAL,
    root: true,
    links: linkTo(row.TraceParent),
    attributes: { [SpinaAttr.Workflow]: row.Workflow, [SpinaAttr.WorkflowInstance]: row.Id, [SpinaAttr.WorkflowVersion]: row.Version },
  });
  try {
    return await context.with(trace.setSpan(ROOT_CONTEXT, span), () => fn(span));
  } catch (err) {
    markSpanErrorType(span, err);
    throw err;
  } finally {
    span.end();
  }
}
