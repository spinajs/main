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

export class SpanProcessorHub implements SpanProcessor {
  // Replaced, never mutated: a detach during onEnd must not skip a sibling.
  private processors: readonly SpanProcessor[] = [];

  public get size(): number {
    return this.processors.length;
  }

  public add(processor: SpanProcessor): () => Promise<void> {
    this.processors = [...this.processors, processor];
    let attached = true;
    return async () => {
      if (!attached) return;
      attached = false;
      this.processors = this.processors.filter((p) => p !== processor);
      await processor.forceFlush();
      await processor.shutdown();
    };
  }

  public onStart(span: Span, parentContext: Context): void {
    for (const p of this.processors) guarded(() => p.onStart(span, parentContext));
  }

  public onEnd(span: ReadableSpan): void {
    for (const p of this.processors) guarded(() => p.onEnd(span));
  }

  public async forceFlush(): Promise<void> {
    await Promise.all(this.processors.map((p) => p.forceFlush()));
  }

  public async shutdown(): Promise<void> {
    const detached = this.processors;
    this.processors = [];
    await Promise.all(detached.map((p) => p.shutdown()));
  }
}

export class HubSampler implements Sampler {
  constructor(
    private readonly hub: SpanProcessorHub,
    private readonly delegate: Sampler,
  ) {}

  public shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
    return this.hub.size === 0 ? NOT_RECORDED : this.delegate.shouldSample(context, traceId, spanName, spanKind, attributes, links);
  }

  public toString(): string {
    return `HubSampler{${this.delegate.toString()}}`;
  }
}
