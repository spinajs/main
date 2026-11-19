import { Injectable, Singleton, AsyncService, Autoinject } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ProxyTracerProvider, Tracer, Span, SpanStatusCode, Attributes, trace } from '@opentelemetry/api';
import { BatchSpanProcessor, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { markSpanErrorType } from '@spinajs/tracing';
import { ensureTracing, readTracingOptions, tracingState } from '@spinajs/tracing';

const REMOVED_KEYS = ['otel.serviceName', 'otel.resourceAttributes'];

/**
 * Exports the spans of the shared tracer provider of `@spinajs/tracing` over OTLP/HTTP.
 *
 * The provider, its resource (`tracing.serviceName`, `tracing.resourceAttributes`) and its sampler belong to
 * `@spinajs/tracing`; `otel.enabled` decides only whether the OTLP processor is attached to its hub. While
 * attached, `tracer()` is the global tracer, and the exporter sees every framework span (HTTP, policy, authz,
 * ORM, queue), not only `withSpan` spans. With `otel.enabled=false` nothing is attached and `tracer()` hands
 * out the OTel API no-op tracer, so call sites cost nothing.
 *
 * `start( processor )` accepts a processor override so tests can plug an
 * InMemorySpanExporter without any network.
 */
@Singleton()
@Injectable()
export class OtelTracing extends AsyncService {
  @Logger('otel')
  protected log!: Log;

  @Config('otel.enabled', { defaultValue: false })
  protected enabled!: boolean;

  @Config('otel.endpoint', { defaultValue: 'https://otel.highlight.io:4318/v1/traces' })
  protected endpoint!: string;

  @Autoinject(Configuration)
  protected cfg!: Configuration;

  private processor?: SpanProcessor;
  private detach?: () => Promise<void>;
  private warnedAboutRemovedKeys = false;

  // A delegate-less proxy provider hands out no-op tracers regardless of any OTel global provider.
  private readonly noopProvider = new ProxyTracerProvider();

  private readonly shutdownHooks: Array<() => void> = [];

  public async resolve(): Promise<void> {
    await super.resolve();
    this.start();
  }

  /** Register a callback run at the start of `dispose()`, before the processor is detached. */
  public onBeforeShutdown(hook: () => void): void {
    this.shutdownHooks.push(hook);
  }

  /** Attaches the OTLP processor (or the override) to the shared tracing hub; idempotent, a no-op when disabled. */
  public start(processorOverride?: SpanProcessor): void {
    if (!this.enabled || this.detach) {
      return;
    }
    this.warnAboutRemovedKeys();
    const state = tracingState().owner === 'none' ? ensureTracing(readTracingOptions(this.cfg)) : tracingState();
    if (!state.hub) {
      const reason = state.owner === 'external' ? 'another OpenTelemetry SDK owns tracing; register the OTLP exporter with that SDK' : 'tracing.enabled is false';
      this.log.warn({ reason }, 'otel export not started: ${reason}');
      return;
    }
    const processor = processorOverride ?? this.otlpProcessor();
    if (!processor) {
      return;
    }
    this.processor = processor;
    this.detach = state.hub.add(processor);
    this.log.info({ endpoint: this.endpoint }, 'otel export started (endpoint=${endpoint})');
  }

  // The exporter validates otel.endpoint (and the OTEL_EXPORTER_OTLP_* variables) when it is built; a bad value
  // must not fail the resolve of this service, and with it every service that injects it.
  private otlpProcessor(): SpanProcessor | undefined {
    try {
      return new BatchSpanProcessor(new OTLPTraceExporter({ url: this.endpoint }));
    } catch (err) {
      this.log.error({ error: err, endpoint: this.endpoint }, 'otel export not started: no OTLP exporter for ${endpoint}');
      return undefined;
    }
  }

  /**
   * 3.x took the service name and the resource attributes from these two keys. 4.0 reads `tracing.*` only, and an
   * app that kept the old keys would otherwise export under its package name without a word. Their values are not used.
   * Once per instance: `start()` runs again whenever the export could not attach.
   */
  private warnAboutRemovedKeys(): void {
    if (this.warnedAboutRemovedKeys) {
      return;
    }
    this.warnedAboutRemovedKeys = true;

    const removed = REMOVED_KEYS.filter((key) => this.cfg.get<unknown>(key) !== undefined);
    if (removed.length > 0) {
      this.log.warn({ removed: removed.join(', ') }, 'otel: ${removed} is no longer read; set tracing.serviceName and tracing.resourceAttributes instead');
    }
  }

  public get active(): boolean {
    return this.detach !== undefined;
  }

  /** The global tracer while the export is attached, or the API no-op tracer when off. */
  public tracer(name: string): Tracer {
    return this.active ? trace.getTracer(name) : this.noopProvider.getTracer(name);
  }

  /** Run `fn` inside a span; on a throw, sets ERROR and `error.type` to the error's class, never its message. */
  public async withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.tracer('spinajs').startSpan(name, { attributes: attrs });
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      markSpanErrorType(span, err);
      throw err;
    } finally {
      span.end();
    }
  }

  public async flush(): Promise<void> {
    await this.processor?.forceFlush();
  }

  public async dispose(): Promise<void> {
    for (const hook of this.shutdownHooks.splice(0)) {
      try {
        hook();
      } catch (err) {
        this.log.warn({ error: err }, 'otel shutdown hook failed');
      }
    }
    const detach = this.detach;
    this.detach = undefined;
    this.processor = undefined;
    try {
      await detach?.();
    } catch (err) {
      // A collector that is down or slow fails the last flush; the spans are lost either way, and the app's
      // shutdown must go on.
      this.log.warn({ error: err }, 'otel export: the spans still buffered at shutdown were not exported');
    }
    await super.dispose();
  }
}
