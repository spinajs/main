import { isSpanContextValid, trace } from "@opentelemetry/api";
import { LogContext, scalarContext } from "./context.js";

export function activeTraceFields(): Record<string, string> {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && !sc.isRemote && isSpanContextValid(sc) ? { traceId: sc.traceId, spanId: sc.spanId } : {};
}

// Spread last: inside an action the active span is a child of the server span whose ids sit on the request store.
export function ambientLogContext(): Record<string, unknown> {
  return { ...scalarContext(LogContext.active()), ...activeTraceFields() };
}
