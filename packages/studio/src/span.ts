import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Attributes, HrTime, Link, SpanContext, SpanStatus } from '@opentelemetry/api';

import type { StudioSpan } from './contracts/index.js';

/**
 * The part of an OpenTelemetry SDK 2.x `ReadableSpan` Studio reads. Declared here so Studio depends on
 * `@opentelemetry/api` only; an SDK span is assignable to it.
 */
export interface ReadableSpanLike {
  readonly name: string;
  readonly kind: SpanKind;
  spanContext(): SpanContext;
  readonly parentSpanContext?: SpanContext;
  readonly startTime: HrTime;
  readonly duration: HrTime;
  readonly status: SpanStatus;
  readonly attributes: Attributes;
  readonly links: readonly Link[];
  readonly events: readonly { readonly name: string; readonly time: HrTime; readonly attributes?: Attributes }[];
  readonly instrumentationScope: { readonly name: string };
}

export type SpanStartLike = Pick<ReadableSpanLike, 'name' | 'kind' | 'spanContext' | 'parentSpanContext' | 'startTime' | 'attributes'>;

export interface CaptureOptions {
  readonly redact: ReadonlySet<string>;
  readonly captureBindings: boolean;
}

export const MAX_ATTRIBUTE_BYTES = 2048;

/** OTel semantic convention for SQL bindings. */
const BINDING_PREFIX = 'db.query.parameter.';

// Object header, ids, timestamps and the attribute map of one buffered span.
const SPAN_OVERHEAD_BYTES = 256;
const LINK_BYTES = 64;

const KINDS: Record<SpanKind, StudioSpan['kind']> = {
  [SpanKind.INTERNAL]: 'internal',
  [SpanKind.SERVER]: 'server',
  [SpanKind.CLIENT]: 'client',
  [SpanKind.PRODUCER]: 'producer',
  [SpanKind.CONSUMER]: 'consumer',
};

const STATUSES: Record<SpanStatusCode, StudioSpan['status']> = {
  [SpanStatusCode.UNSET]: 'unset',
  [SpanStatusCode.OK]: 'ok',
  [SpanStatusCode.ERROR]: 'error',
};

export function hrTimeToNanos(t: HrTime): bigint {
  return BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]);
}

export function kindOf(kind: SpanKind): StudioSpan['kind'] {
  return KINDS[kind] ?? 'internal';
}

/** No local parent: the root of the trace in this process, also when a remote caller started the trace. */
export function isLocalRoot(span: Pick<ReadableSpanLike, 'parentSpanContext'>): boolean {
  return span.parentSpanContext === undefined || span.parentSpanContext.isRemote === true;
}

export function truncate(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= MAX_ATTRIBUTE_BYTES) return value;
  // A cut through a multi-byte character decodes to U+FFFD; drop it.
  return `${Buffer.from(value, 'utf8').subarray(0, MAX_ATTRIBUTE_BYTES).toString('utf8').replace(/�+$/, '')}…`;
}

function listValue(values: readonly (string | number | boolean | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v !== null && v !== undefined) out.push(truncate(String(v)));
  }
  return out;
}

export function sanitizeAttributes(attributes: Attributes | undefined, options: CaptureOptions): StudioSpan['attributes'] {
  const out: StudioSpan['attributes'] = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null) continue;
    if (!options.captureBindings && key.startsWith(BINDING_PREFIX)) continue;
    if (options.redact.has(key)) out[key] = '[redacted]';
    else if (Array.isArray(value)) out[key] = listValue(value);
    else out[key] = typeof value === 'string' ? truncate(value) : value;
  }
  return out;
}

export function toStudioSpan(span: ReadableSpanLike, options: CaptureOptions): StudioSpan {
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(span.parentSpanContext ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: truncate(span.name),
    kind: kindOf(span.kind),
    startUnixNano: hrTimeToNanos(span.startTime).toString(),
    durationNs: hrTimeToNanos(span.duration).toString(),
    status: STATUSES[span.status.code] ?? 'unset',
    ...(span.status.message ? { statusMessage: truncate(span.status.message) } : {}),
    attributes: sanitizeAttributes(span.attributes, options),
    events: span.events.map((e) => ({ name: truncate(e.name), timeUnixNano: hrTimeToNanos(e.time).toString(), attributes: sanitizeAttributes(e.attributes, options) })),
    links: span.links.map((l) => ({ traceId: l.context.traceId, spanId: l.context.spanId })),
    scope: span.instrumentationScope.name,
  };
}

function unitsOf(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (!Array.isArray(value)) return 8;
  let units = 0;
  for (const item of value) units += unitsOf(item);
  return units;
}

function attributeUnits(attributes: Readonly<Record<string, unknown>>): number {
  let units = 0;
  for (const [key, value] of Object.entries(attributes)) units += key.length + unitsOf(value);
  return units;
}

/** What a buffered span costs in memory, roughly: two bytes per UTF-16 unit of its strings plus fixed overheads. */
export function approximateBytes(span: StudioSpan): number {
  let units = span.name.length + (span.statusMessage?.length ?? 0) + attributeUnits(span.attributes);
  for (const event of span.events) units += event.name.length + attributeUnits(event.attributes);
  return SPAN_OVERHEAD_BYTES + LINK_BYTES * span.links.length + 2 * units;
}
