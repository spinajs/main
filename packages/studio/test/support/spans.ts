import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, HrTime } from '@opentelemetry/api';

import type { ReadableSpanLike } from '../../src/span.js';

let next = 0;
const hex = (value: string, length: number) => value.padStart(length, '0').slice(-length);
const hr = (ms: number): HrTime => [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];

export interface FakeSpan {
  trace: string;
  id?: string;
  parent?: string;
  remoteParent?: boolean;
  name?: string;
  kind?: SpanKind;
  startMs?: number;
  durationMs?: number;
  status?: SpanStatusCode;
  attributes?: Attributes;
}

/** A plain object with the ReadableSpan fields Studio reads; ids are padded to the W3C lengths. */
export function fakeSpan(o: FakeSpan): ReadableSpanLike {
  const traceId = hex(o.trace, 32);
  const spanId = hex(o.id ?? String(++next), 16);
  return {
    name: o.name ?? `span ${spanId}`,
    kind: o.kind ?? SpanKind.INTERNAL,
    spanContext: () => ({ traceId, spanId, traceFlags: 1 }),
    ...(o.parent ? { parentSpanContext: { traceId, spanId: hex(o.parent, 16), traceFlags: 1, isRemote: o.remoteParent === true } } : {}),
    startTime: hr(o.startMs ?? 1_000),
    duration: hr(o.durationMs ?? 10),
    status: { code: o.status ?? SpanStatusCode.UNSET },
    attributes: o.attributes ?? {},
    links: [],
    events: [],
    instrumentationScope: { name: '@spinajs' },
  };
}

export const traceIdOf = (trace: string) => hex(trace, 32);
