import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import type { Context, Link, Span } from '@opentelemetry/api';
import { SpinaAttr, activeTraceIds, extractTraceContext, traceparentOf, tracer } from '@spinajs/tracing';

import type { RunModel } from '../models/RunModel.js';

function linkTo(traceparent: string | null): Link[] {
  if (!traceparent) return [];
  const sc = trace.getSpanContext(extractTraceContext({ traceparent }, ROOT_CONTEXT));
  return sc ? [{ context: sc }] : [];
}

/** The span of one attempt under `parent`: `ROOT_CONTEXT` for the scheduler loop, the caller's context for an inline run. */
export function startRunSpan(run: RunModel, continues: string | null, parent: Context): Span {
  // a model built without the field has `undefined` there, a stored run has `null`
  const resumed = run.Attempt > 1 || Boolean(run.ResumeFrom);
  return tracer().startSpan(
    `run ${run.Schedule}`,
    {
      kind: SpanKind.INTERNAL,
      links: linkTo(continues),
      attributes: {
        [SpinaAttr.RunId]: run.Id,
        [SpinaAttr.Schedule]: run.Schedule,
        [SpinaAttr.Attempt]: run.Attempt,
        [SpinaAttr.Trigger]: run.Trigger,
        ...(resumed ? { [SpinaAttr.Resumed]: true } : {}),
      },
    },
    parent,
  );
}

export function currentTraceParent(): string | null {
  const ids = activeTraceIds();
  return ids ? traceparentOf(ids) : null;
}
