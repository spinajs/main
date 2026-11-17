// Types only: `@spinajs/studio/contracts` is what the Studio UI compiles against.
import type { Decision, DenyReason, Trace } from '@spinajs/authz';
import type { ServiceEntry, SourceRef } from '@spinajs/manifest';

export type StudioSource = 'manifest' | 'runtime' | 'merged';

export interface StudioFeatures {
  traces: boolean;
  logs: boolean;
  slowQueries: boolean;
  di: boolean;
  routes: boolean;
  authz: boolean;
  explain: boolean;
  rebac: boolean;
  telemetry: boolean;
  scheduler: boolean;
}

/** `GET /_studio/api/capabilities` */
export interface StudioCapabilities {
  version: string;
  manifest: { loaded: boolean; hash?: string; mode?: 'off' | 'prefer' | 'require' };
  tracing: { owner: 'spinajs' | 'external' | 'none'; recording: boolean };
  features: StudioFeatures;
  /** Studio permissions the caller holds, so the UI can hide what it cannot open. */
  permissions: string[];
}

/** One page of a list; `cursor` is opaque to the client and goes back as the `cursor` query parameter. */
export interface StudioPage<T> {
  items: T[];
  total?: number;
  cursor?: string;
}

export interface StudioSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 'server' | 'client' | 'producer' | 'consumer' | 'internal';
  /** Nanoseconds since the epoch, as a decimal string. */
  startUnixNano: string;
  durationNs: string;
  status: 'unset' | 'ok' | 'error';
  statusMessage?: string;
  attributes: Record<string, string | number | boolean | string[]>;
  events: { name: string; timeUnixNano: string; attributes: Record<string, unknown> }[];
  links: { traceId: string; spanId: string }[];
  /** Name of the instrumentation scope that created the span. */
  scope: string;
}

export interface TraceSummary {
  traceId: string;
  rootName: string;
  rootKind: StudioSpan['kind'];
  startUnixNano: string;
  durationNs: string;
  spanCount: number;
  errorCount: number;
  route?: string;
  statusCode?: number;
  principalId?: string;
  /** False while the local root span has not ended. */
  complete: boolean;
}

export interface StudioLogLine {
  time: string;
  level: string;
  logger: string;
  message: string;
  traceId?: string;
  spanId?: string;
  fields: Record<string, unknown>;
}

export interface TraceDetail {
  summary: TraceSummary;
  spans: StudioSpan[];
  logs: StudioLogLine[];
  /** Spans are missing: the trace passed `studio.buffers.spansPerTrace` or came back after its eviction. */
  truncated: boolean;
}

/** Query of `GET /_studio/api/traces`; `from` and `to` are ISO dates. */
export interface TraceQuery {
  route?: string;
  name?: string;
  status?: 'error' | 'ok';
  minDurationMs?: number;
  principalId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

/** `group` is the package that registers the node, known from the manifest only. */
export interface GraphNode { id: string; label: string; kind: string; group?: string; attributes: Record<string, string | number | boolean> }
export interface GraphEdge { id: string; source: string; target: string; kind: string; label?: string }
/** Every Studio graph endpoint answers this; `truncated` is true when a limit cut nodes. */
export interface StudioGraph { source: StudioSource; nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean }
export interface DiInjection { token: string; kind: 'ctor' | 'property' | 'lazy'; optional: boolean; array: boolean; mapped?: boolean; property?: string }
export interface DiImplementation { name: string; kind: string; lifetime: string; instantiated: boolean; async: boolean; injects: DiInjection[]; error?: string }
/** `GET /_studio/api/di/services/:id` */
export interface DiServiceDetail { token: string; source: StudioSource; implementations: DiImplementation[]; injectedBy: { token: string; kind: string }[]; manifest: ServiceEntry[]; sourceRef?: SourceRef; runtime?: { resolving: boolean } }

export interface StudioAuthzPermission { name: string; description?: string; types?: string[] }
export interface StudioAuthzDomain { name: string; parent?: string; models: string[]; algorithm: string; typeAlgorithms: Record<string, string>; permissions: StudioAuthzPermission[]; error?: string }

export type { DenyReason, ResourceFilter, Trace } from '@spinajs/authz';
/** `Decision` as JSON carries it: `validUntil` is an ISO string; the trace travels beside it, in `StudioExplainResult.trace`. */
export type StudioDecision = Omit<Decision, 'validUntil' | 'trace'> & { validUntil?: string };
export interface StudioExplainInput { domain?: string; principal: string; permission: string; resource?: string }
export interface StudioExplainResult { decision: StudioDecision; trace?: Trace; denies: DenyReason[] }

export interface StudioTupleRef { type: string; id: string; relation?: string }
export interface StudioTuple { object: StudioTupleRef; relation: string; subject: StudioTupleRef }

export interface RouteInfo { method: string; path: string; controller: string; action: string; policies: string[][]; access: string[]; controllerPolicies: string[][]; controllerAccess: string[]; allowAnonymous: boolean; unguarded: boolean; source?: SourceRef; stats?: { count: number; errorRate: number; p50Ms: number; p95Ms: number }; telemetry?: { count: number; errorRate: number } }
/** `GET /_studio/api/routes`; `total` is the number of mounted routes, `cursor` (opaque) the start of the next page. */
export interface StudioRoutes { source: StudioSource; data: RouteInfo[]; total?: number; cursor?: string }
