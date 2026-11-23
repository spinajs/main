import type { Context } from '@opentelemetry/api';

import type { StudioSpan } from './contracts/index.js';
import type { CaptureOptions, ReadableSpanLike, SpanStartLike } from './span.js';
import { isLocalRoot, toStudioSpan } from './span.js';

export interface SpanSink {
  readonly capture: CaptureOptions;
  start(span: SpanStartLike): void;
  end(span: StudioSpan, isRoot: boolean): void;
}

/**
 * Feeds spans into the Studio trace store. Studio attaches one to the `@spinajs/tracing` hub when it mounts; an app
 * that owns its OpenTelemetry SDK adds `studioSpanProcessor()` to it instead. Spans arriving before Studio mounted
 * are dropped.
 */
export class StudioSpanProcessor {
  public constructor(private readonly sink: () => SpanSink | undefined) {}

  public onStart(span: SpanStartLike, _parentContext: Context): void {
    this.sink()?.start(span);
  }

  public onEnd(span: ReadableSpanLike): void {
    const sink = this.sink();
    if (sink) sink.end(toStudioSpan(span, sink.capture), isLocalRoot(span));
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
