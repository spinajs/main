import { diag } from '@opentelemetry/api';
import type { Attributes, Context, Link, SpanKind } from '@opentelemetry/api';
import { SamplingDecision } from '@opentelemetry/sdk-trace-base';
import type { ReadableSpan, Sampler, SamplingResult, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

const NOT_RECORDED: SamplingResult = Object.freeze({ decision: SamplingDecision.NOT_RECORD });

// span.end() runs on the request path: one broken processor must neither fail the request nor starve the others.
function guarded(call: () => void): void {
  try {
    call();
  } catch (err) {
    diag.error('@spinajs/tracing: a span processor threw', err);
  }
}

// Every processor gets the call even when one fails; the first failure is rethrown once all have settled.
async function settleAll(calls: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(calls.map(async (call) => call()));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    const reason: unknown = failed.reason;
    throw reason instanceof Error ? reason : new Error(String(reason));
  }
}

export interface HubProcessorOptions {
  /**
   * The processor only decorates spans that other processors record (it sets attributes in `onStart`): the hub starts
   * it first and, while nothing else is attached, still records no span, so importing an enricher keeps id-only tracing.
   */
  readonly enricher?: boolean;
}

export class SpanProcessorHub implements SpanProcessor {
  // Replaced, never mutated: a detach during onEnd must not skip a sibling.
  private enrichers: readonly SpanProcessor[] = [];
  private sinks: readonly SpanProcessor[] = [];
  private processors: readonly SpanProcessor[] = [];

  /** Counts enrichers too; whether spans are recorded is `recording`. */
  public get size(): number {
    return this.processors.length;
  }

  /** A processor other than an enricher is attached, so spans are worth recording. */
  public get recording(): boolean {
    return this.sinks.length > 0;
  }

  public add(processor: SpanProcessor, options: HubProcessorOptions = {}): () => Promise<void> {
    if (options.enricher) this.enrichers = [...this.enrichers, processor];
    else this.sinks = [...this.sinks, processor];
    this.processors = [...this.enrichers, ...this.sinks];
    let attached = true;
    return async () => {
      if (!attached) return;
      attached = false;
      this.enrichers = this.enrichers.filter((p) => p !== processor);
      this.sinks = this.sinks.filter((p) => p !== processor);
      this.processors = [...this.enrichers, ...this.sinks];
      try {
        await processor.forceFlush();
      } finally {
        await processor.shutdown();
      }
    };
  }

  public onStart(span: Span, parentContext: Context): void {
    for (const p of this.processors) guarded(() => p.onStart(span, parentContext));
  }

  public onEnding(span: Span): void {
    for (const p of this.processors) guarded(() => p.onEnding?.(span));
  }

  public onEnd(span: ReadableSpan): void {
    for (const p of this.processors) guarded(() => p.onEnd(span));
  }

  public forceFlush(): Promise<void> {
    return settleAll(this.processors.map((p) => () => p.forceFlush()));
  }

  public shutdown(): Promise<void> {
    const detached = this.processors;
    this.enrichers = [];
    this.sinks = [];
    this.processors = [];
    return settleAll(detached.map((p) => () => p.shutdown()));
  }
}

export class HubSampler implements Sampler {
  constructor(
    private readonly hub: SpanProcessorHub,
    private readonly delegate: Sampler,
  ) {}

  public shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
    return this.hub.recording ? this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links) : NOT_RECORDED;
  }

  public toString(): string {
    return `HubSampler{${this.delegate.toString()}}`;
  }
}
