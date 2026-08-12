import { Injectable, Singleton, AsyncService, Autoinject } from '@spinajs/di';
import { Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { Span, SpanStatusCode, Attributes, trace, context, ROOT_CONTEXT } from '@opentelemetry/api';
import { OtelTracing } from './tracing.js';

interface IOpenSpan {
  span: Span;
  openedAt: number;
}

/**
 * Keyed registry for long-lived spans (minutes) that cannot be scoped to one
 * async call — e.g. one root span per payment transaction, opened when the
 * transaction starts and closed by whichever handler sees the terminal state.
 *
 * Every method is a guarded no-op when tracing is disabled, the key is unknown
 * or the underlying OTel call throws: observability must never break the
 * business flow. An orphan sweep force-closes spans that outlive
 * `otel.longSpan.maxAgeMs` (crashed flows, lost terminal messages).
 */
@Singleton()
@Injectable()
export class LongSpanRegistry extends AsyncService {
  @Logger('otel')
  protected log!: Log;

  @Autoinject(OtelTracing)
  protected tracing!: OtelTracing;

  @Config('otel.longSpan.maxAgeMs', { defaultValue: 30 * 60_000 })
  protected maxAgeMs!: number;

  @Config('otel.longSpan.sweepIntervalMs', { defaultValue: 60_000 })
  protected sweepIntervalMs!: number;

  private readonly spans = new Map<string, IOpenSpan>();
  private timer?: NodeJS.Timeout;

  /** Open a span under `key`; a stale span on the same key is closed as replaced. */
  public open(key: string, name: string, attrs?: Attributes): void {
    try {
      const stale = this.spans.get(key);
      if (stale) {
        stale.span.setAttribute('replaced', true);
        stale.span.setStatus({ code: SpanStatusCode.ERROR, message: 'replaced by a new span on the same key' });
        stale.span.end();
        this.spans.delete(key);
      }
      const span = this.tracing.tracer('paystation').startSpan(name, { attributes: attrs });
      this.spans.set(key, { span, openedAt: Date.now() });
      this.ensureSweepTimer();
    } catch (err) {
      this.log.warn(`long-span open('${key}') failed: ${(err as Error).message}`);
    }
  }

  /** Add a span event; no-op when key is undefined/unknown. */
  public event(key: string | undefined, name: string, attrs?: Attributes): void {
    try {
      if (!key) return;
      this.spans.get(key)?.span.addEvent(name, attrs);
    } catch (err) {
      this.log.warn(`long-span event('${key ?? ''}') failed: ${(err as Error).message}`);
    }
  }

  public setAttributes(key: string, attrs: Attributes): void {
    try {
      this.spans.get(key)?.span.setAttributes(attrs);
    } catch (err) {
      this.log.warn(`long-span setAttributes('${key}') failed: ${(err as Error).message}`);
    }
  }

  public has(key: string): boolean {
    return this.spans.has(key);
  }

  /** Close and export the span; no-op for unknown keys. */
  public close(key: string, status: 'ok' | 'error', attrs?: Attributes): void {
    try {
      const entry = this.spans.get(key);
      if (!entry) return;
      if (attrs) entry.span.setAttributes(attrs);
      entry.span.setStatus({ code: status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      entry.span.end();
      this.spans.delete(key);
      if (this.spans.size === 0) this.stopSweepTimer();
    } catch (err) {
      this.log.warn(`long-span close('${key}') failed: ${(err as Error).message}`);
    }
  }

  /**
   * Run `fn` inside a short span, parented into the open long span for `key`
   * when there is one (giving kiosk round-trips a place in the transaction
   * waterfall), standalone otherwise. Errors are recorded and re-thrown.
   */
  public async childSpan<T>(key: string | undefined, name: string, attrs: Attributes, fn: () => Promise<T>): Promise<T> {
    let span: Span | undefined;
    try {
      const parent = key ? this.spans.get(key)?.span : undefined;
      const ctx = parent ? trace.setSpan(ROOT_CONTEXT, parent) : context.active();
      span = this.tracing.tracer('paystation').startSpan(name, { attributes: attrs }, ctx);
    } catch (err) {
      this.log.warn(`long-span childSpan('${name}') failed to start: ${(err as Error).message}`);
    }
    try {
      const result = await fn();
      span?.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span?.recordException(err as Error);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span?.end();
    }
  }

  /** Force-close spans that outlived `maxAgeMs` (public for tests). */
  public sweep(): void {
    const cutoff = Date.now() - this.maxAgeMs;
    for (const [key, entry] of this.spans) {
      if (entry.openedAt <= cutoff) {
        this.log.warn(`long-span '${key}' exceeded maxAgeMs; closing as orphaned`);
        entry.span.setAttribute('orphaned', true);
        entry.span.setStatus({ code: SpanStatusCode.ERROR, message: 'span outlived otel.longSpan.maxAgeMs' });
        entry.span.end();
        this.spans.delete(key);
      }
    }
    if (this.spans.size === 0) this.stopSweepTimer();
  }

  private ensureSweepTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.timer.unref?.();
  }

  private stopSweepTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  public async dispose(): Promise<void> {
    for (const key of [...this.spans.keys()]) {
      this.close(key, 'error', { shutdown: true });
    }
    this.stopSweepTimer();
    await super.dispose();
  }
}
