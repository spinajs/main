import { Config } from '@spinajs/configuration';
import { AsyncService, Injectable, Singleton } from '@spinajs/di';
import { InvalidOperation } from '@spinajs/exceptions';
import { configuredMountPath, withRoutePrefix } from '@spinajs/manifest';
import { SpinaAttr, tracingState } from '@spinajs/tracing';

import type { StudioPage, StudioSpan, TraceDetail, TraceQuery, TraceSummary } from '../contracts/index.js';
import { StudioSpanProcessor } from '../processor.js';
import type { SpanSink } from '../processor.js';
import type { CaptureOptions, SpanStartLike } from '../span.js';
import { approximateBytes, hrTimeToNanos, isLocalRoot, kindOf, truncate } from '../span.js';

export interface TraceStoreOptions {
  traces: number;
  spansPerTrace: number;
  /** Approximate bytes of buffered span data; past it the first buffered traces go. */
  maxBytes: number;
  capture: CaptureOptions;
  /** Served Studio base path, the global `http.controllers.route.prefix` included; requests under it are not recorded. */
  basePath: string;
}

// The counters are kept as spans end, so a summary never walks the spans (a list call touches every trace).
interface TraceEntry {
  readonly traceId: string;
  startNs: bigint;
  endNs: bigint;
  readonly spans: StudioSpan[];
  bytes: number;
  errorCount: number;
  principalId?: string;
  root?: StudioSpan;
  openRoot?: Pick<StudioSpan, 'name' | 'kind'>;
  truncated: boolean;
}

const DEFAULT_LIMIT = 50;
// Open spans of Studio's own requests tracked at once; past it a new one is recorded like any other span.
const OWN_OPEN_CAP = 4096;

// Express matches routes regardless of letter case, and url.path keeps the client's.
function isUnder(path: unknown, base: string): boolean {
  return typeof path === 'string' && (base === '/' || path.toLowerCase() === base.toLowerCase() || path.toLowerCase().startsWith(`${base.toLowerCase()}/`));
}

function spanEndNs(span: StudioSpan): bigint {
  return BigInt(span.startUnixNano) + BigInt(span.durationNs);
}

function rootFacts(root: StudioSpan | undefined): Pick<TraceSummary, 'route' | 'statusCode'> {
  const route = root?.attributes['http.route'];
  const statusCode = root?.attributes['http.response.status_code'];
  return { ...(typeof route === 'string' ? { route } : {}), ...(typeof statusCode === 'number' ? { statusCode } : {}) };
}

function summarize(entry: TraceEntry): TraceSummary {
  const head = entry.root ?? entry.openRoot ?? entry.spans[0];
  return {
    traceId: entry.traceId,
    rootName: head?.name ?? '',
    rootKind: head?.kind ?? 'internal',
    startUnixNano: entry.startNs.toString(),
    durationNs: (entry.root ? BigInt(entry.root.durationNs) : entry.endNs - entry.startNs).toString(),
    spanCount: entry.spans.length,
    errorCount: entry.errorCount,
    ...rootFacts(entry.root),
    ...(entry.principalId !== undefined ? { principalId: entry.principalId } : {}),
    complete: entry.root !== undefined,
  };
}

const msToNs = (ms: number): bigint => BigInt(Math.round(ms)) * 1_000_000n;

function matchesFields(s: TraceSummary, q: TraceQuery): boolean {
  if (q.route !== undefined && s.route !== q.route) return false;
  if (q.name !== undefined && !s.rootName.includes(q.name)) return false;
  if (q.status === 'error' && s.errorCount === 0) return false;
  if (q.status === 'ok' && s.errorCount > 0) return false;
  return q.principalId === undefined || s.principalId === q.principalId;
}

// `from` and `to` are dates the controller already checked with Date.parse.
function matchesTime(s: TraceSummary, q: TraceQuery): boolean {
  const start = BigInt(s.startUnixNano);
  if (q.minDurationMs !== undefined && BigInt(s.durationNs) < BigInt(Math.round(q.minDurationMs * 1e6))) return false;
  if (q.from !== undefined && start < msToNs(Date.parse(q.from))) return false;
  return q.to === undefined || start <= msToNs(Date.parse(q.to));
}

function newestFirst(a: TraceSummary, b: TraceSummary): number {
  const sa = BigInt(a.startUnixNano);
  const sb = BigInt(b.startUnixNano);
  if (sa !== sb) return sa > sb ? -1 : 1;
  return a.traceId > b.traceId ? -1 : a.traceId < b.traceId ? 1 : 0;
}

const cursorOf = (s: TraceSummary): string => `${s.startUnixNano}:${s.traceId}`;

function after(cursor: string | undefined): (s: TraceSummary) => boolean {
  if (cursor === undefined) return () => true;
  const at = cursor.indexOf(':');
  const start = BigInt(cursor.slice(0, at));
  const traceId = cursor.slice(at + 1);
  return (s) => {
    const own = BigInt(s.startUnixNano);
    return own < start || (own === start && s.traceId < traceId);
  };
}

/** Spans of the last traces of this process, bounded by count and by bytes; nothing is persisted. */
@Singleton()
@Injectable()
export class TraceStore extends AsyncService implements SpanSink {
  @Config('studio.buffers.traces', { defaultValue: 1000 })
  protected Traces: number;

  @Config('studio.buffers.spansPerTrace', { defaultValue: 2000 })
  protected SpansPerTrace: number;

  @Config('studio.buffers.traceBytes', { defaultValue: 67_108_864 })
  protected TraceBytes: number;

  @Config('studio.redactAttributes', { defaultValue: [] })
  protected Redact: string[];

  @Config('studio.captureBindings', { defaultValue: false })
  protected CaptureBindings: unknown;

  @Config('studio.path', { defaultValue: '/_studio' })
  protected Path: string;

  @Config('http.controllers.route.prefix')
  protected Prefix: string | undefined;

  private configured?: TraceStoreOptions;
  // Insertion order is arrival order, which eviction follows.
  private readonly traces = new Map<string, TraceEntry>();
  private readonly listeners = new Set<(summary: TraceSummary) => void>();
  // Span ids of Studio's own requests that are still open: a local root under basePath and what started below it.
  private readonly own = new Set<string>();
  // Trace ids evicted lately: such a trace is partial when a late span re-creates it.
  private readonly evicted = new Set<string>();
  private bytes = 0;
  private revision = 0;
  private detach?: () => Promise<void>;

  /** `options` is for tests; DI constructs the store without arguments and reads the configuration in `resolve`. */
  public constructor(options?: TraceStoreOptions) {
    super();
    if (options) this.configured = options;
  }

  private get options(): TraceStoreOptions {
    if (!this.configured) throw new InvalidOperation('the Studio trace store is used before it was resolved');
    return this.configured;
  }

  public get capture(): CaptureOptions {
    return this.options.capture;
  }

  public get size(): number {
    return this.traces.size;
  }

  public get version(): number {
    return this.revision;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    const mount = configuredMountPath(this.Path);
    this.configured ??= {
      traces: this.Traces,
      spansPerTrace: this.SpansPerTrace,
      maxBytes: this.TraceBytes,
      capture: { redact: new Set(this.Redact), captureBindings: this.CaptureBindings === true },
      basePath: withRoutePrefix(this.Prefix, mount === '/' ? '/' : `/${mount}`),
    };
    const hub = tracingState().hub;
    if (hub) this.detach = hub.add(new StudioSpanProcessor(() => this));
  }

  public async dispose(): Promise<void> {
    const detach = this.detach;
    this.detach = undefined;
    await detach?.();
    this.traces.clear();
    this.listeners.clear();
    this.own.clear();
    this.evicted.clear();
    this.bytes = 0;
  }

  public start(span: SpanStartLike): void {
    const ctx = span.spanContext();
    if (this.startsOwn(span)) {
      if (this.own.size < OWN_OPEN_CAP) this.own.add(ctx.spanId);
      return;
    }
    const entry = this.entry(ctx.traceId, hrTimeToNanos(span.startTime));
    if (isLocalRoot(span)) entry.openRoot = { name: truncate(span.name), kind: kindOf(span.kind) };
  }

  public end(span: StudioSpan, isRoot: boolean): void {
    if (this.own.delete(span.spanId)) return;
    // A root whose start was not seen (Studio mounted mid-request) is still judged by its path.
    if (isRoot && isUnder(span.attributes['url.path'], this.options.basePath)) return;

    const entry = this.entry(span.traceId, BigInt(span.startUnixNano));
    const recorded = this.record(entry, span);
    if (!isRoot) return;

    // A root past spansPerTrace is still kept for the summary, so it still counts.
    if (!recorded) this.charge(entry, approximateBytes(span));
    entry.root = span;
    entry.openRoot = undefined;
    this.notify(summarize(entry));
  }

  public list(query: TraceQuery): StudioPage<TraceSummary> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const items = [...this.traces.values()]
      .map(summarize)
      .filter((s) => matchesFields(s, query) && matchesTime(s, query))
      .sort(newestFirst)
      .filter(after(query.cursor));
    const page = items.slice(0, limit);
    return items.length > limit ? { items: page, cursor: cursorOf(page[page.length - 1]) } : { items: page };
  }

  public get(traceId: string): Omit<TraceDetail, 'logs'> | undefined {
    const entry = this.traces.get(traceId);
    return entry ? { summary: summarize(entry), spans: [...entry.spans], truncated: entry.truncated } : undefined;
  }

  public subscribe(listener: (summary: TraceSummary) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Whether the span belongs to a Studio request that is still open. */
  public ownsSpan(spanId: string): boolean {
    return this.own.has(spanId);
  }

  public *spans(): Generator<StudioSpan> {
    for (const entry of this.traces.values()) yield* entry.spans;
  }

  // Own-ness is a property of the local root, never of the trace id: the caller chooses the trace id.
  private startsOwn(span: SpanStartLike): boolean {
    if (isLocalRoot(span)) return isUnder(span.attributes['url.path'], this.options.basePath);
    return span.parentSpanContext !== undefined && this.own.has(span.parentSpanContext.spanId);
  }

  private record(entry: TraceEntry, span: StudioSpan): boolean {
    if (entry.spans.length >= this.options.spansPerTrace) {
      entry.truncated = true;
      return false;
    }
    entry.spans.push(span);
    this.revision++;
    if (span.status === 'error') entry.errorCount++;
    const end = spanEndNs(span);
    if (end > entry.endNs) entry.endNs = end;
    const principal = span.attributes[SpinaAttr.PrincipalId];
    if (entry.principalId === undefined && typeof principal === 'string') entry.principalId = principal;
    this.charge(entry, approximateBytes(span));
    return true;
  }

  private charge(entry: TraceEntry, bytes: number): void {
    entry.bytes += bytes;
    this.bytes += bytes;
    while (this.bytes > this.options.maxBytes && this.traces.size > 1) this.evictFirst(entry);
  }

  private notify(summary: TraceSummary): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(summary);
      } catch {
        // A failing subscriber must not break the span pipeline it runs in.
      }
    }
  }

  private entry(traceId: string, startNs: bigint): TraceEntry {
    const found = this.traces.get(traceId);
    if (found) {
      if (startNs < found.startNs) found.startNs = startNs;
      return found;
    }
    // Looked up before the eviction below, which may push this id out of the remembered set.
    const truncated = this.evicted.delete(traceId);
    if (this.traces.size >= this.options.traces) this.evictFirst();
    const entry: TraceEntry = { traceId, startNs, endNs: startNs, spans: [], bytes: 0, errorCount: 0, truncated };
    this.traces.set(traceId, entry);
    return entry;
  }

  private evictFirst(keep?: TraceEntry): void {
    for (const candidate of this.traces.values()) {
      if (candidate === keep) continue;
      this.traces.delete(candidate.traceId);
      this.bytes -= candidate.bytes;
      this.revision++;
      this.remember(candidate.traceId);
      return;
    }
  }

  private remember(traceId: string): void {
    this.evicted.add(traceId);
    if (this.evicted.size <= this.options.traces) return;
    for (const oldest of this.evicted) {
      this.evicted.delete(oldest);
      return;
    }
  }
}
