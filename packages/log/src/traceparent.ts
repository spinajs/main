/**
 * W3C Trace Context ( traceparent ) utilities.
 *
 * Pure, dependency-free and cross-platform ( Node 20+ and browsers ) — randomness
 * is sourced from the WHATWG `crypto.getRandomValues`, available on `globalThis`
 * in both environments, so this module deliberately does NOT import
 * `node:crypto` and stays safe to bundle for the browser.
 *
 * A W3C `traceparent` header has the shape:
 *
 *   version "-" trace-id "-" parent-id "-" trace-flags
 *   00      -   32 hex    -   16 hex     -   2 hex
 *
 * See https://www.w3.org/TR/trace-context/#traceparent-header.
 */

/**
 * Minimal trace context this service carries on the ambient store and emits on
 * the outbound `traceparent` header.
 */
export interface ITraceContext {
  /** 32-hex-char trace id, shared by every span across services in one trace. */
  traceId: string;
  /** 16-hex-char span id identifying this service's span within the trace. */
  spanId: string;
  /** Whether the trace is sampled ( low bit of the trace-flags ). */
  sampled: boolean;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

/**
 * Parse & validate an inbound `traceparent` header value.
 *
 * @returns the decomposed parts ( plus the derived `sampled` flag ), or `null`
 *          when the value is missing / malformed / forbidden by the spec
 *          ( all-zero trace-id, all-zero parent-id, or version `ff` ).
 */
export function parseTraceparent(value: string | undefined | null): { version: string; traceId: string; parentId: string; flags: string; sampled: boolean } | null {
  if (!value) {
    return null;
  }

  const match = TRACEPARENT_RE.exec(value.toLowerCase());
  if (!match) {
    return null;
  }

  const [, version, traceId, parentId, flags] = match;

  // Spec-forbidden values: version ff is reserved, and all-zero ids are invalid.
  if (version === "ff" || traceId === ZERO_TRACE_ID || parentId === ZERO_SPAN_ID) {
    return null;
  }

  return {
    version,
    traceId,
    parentId,
    flags,
    sampled: (parseInt(flags, 16) & 0x01) === 1,
  };
}

/**
 * Cross-platform `n` random bytes rendered as lowercase hex.
 */
function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buffer);

  let out = "";
  for (const b of buffer) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * A fresh random trace id ( 16 bytes -> 32 lowercase hex chars ).
 */
export function randomTraceId(): string {
  return randomHex(16);
}

/**
 * A fresh random span id ( 8 bytes -> 16 lowercase hex chars ).
 */
export function randomSpanId(): string {
  return randomHex(8);
}

/**
 * Render a {@link ITraceContext} as a W3C `traceparent` header value.
 */
export function formatTraceparent(ctx: ITraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

/**
 * Derive this service's trace context for a request.
 *
 * When `inboundTraceparent` is a valid header we CONTINUE the trace: the trace
 * id and sampled decision are inherited, and a fresh span id is minted for this
 * service's own span ( its parent being the inbound `parent-id` ). Otherwise a
 * brand-new, sampled trace is STARTED.
 */
export function newTraceContext(inboundTraceparent?: string | null): ITraceContext {
  const parsed = parseTraceparent(inboundTraceparent);
  if (parsed) {
    return {
      traceId: parsed.traceId,
      spanId: randomSpanId(),
      sampled: parsed.sampled,
    };
  }

  return {
    traceId: randomTraceId(),
    spanId: randomSpanId(),
    sampled: true,
  };
}
