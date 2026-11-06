import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { TextMapPropagator } from '@opentelemetry/api';

export const W3C_TRACE_CONTEXT = new W3CTraceContextPropagator();

export const W3C_PROPAGATOR: TextMapPropagator = new CompositePropagator({ propagators: [W3C_TRACE_CONTEXT, new W3CBaggagePropagator()] });
