// Types only: `@spinajs/studio/contracts` is what the Studio UI compiles against.
import type { ServiceEntry, SourceRef } from '@spinajs/manifest';

export type StudioSource = 'manifest' | 'runtime' | 'merged';

export interface StudioFeatures {
  traces: boolean;
  logs: boolean;
  slowQueries: boolean;
  di: boolean;
  routes: boolean;
  authz: boolean;
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
