import { Injectable, Singleton, AsyncService, Autoinject } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { ProxyTracerProvider, Tracer, Span, SpanStatusCode, Attributes } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * Boots a private OTel NodeTracerProvider with an OTLP/HTTP trace exporter.
 *
 * Config-driven and disabled by default: with `otel.enabled=false` no provider
 * is created and `tracer()` hands out the OTel API no-op tracer, so call sites
 * cost nothing. The provider is intentionally NOT registered as the OTel
 * global — consumers get tracers through this service.
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

  @Config('otel.serviceName', { defaultValue: 'spinajs-app' })
  protected serviceName!: string;

  @Config('otel.resourceAttributes', { defaultValue: {} })
  protected resourceAttributes!: Record<string, string>;

  @Autoinject(Configuration)
  protected cfg!: Configuration;

  private provider?: NodeTracerProvider;

  // A delegate-less proxy provider hands out no-op tracers regardless of any OTel global provider.
  private readonly noopProvider = new ProxyTracerProvider();

  private readonly shutdownHooks: Array<() => void> = [];

  public async resolve(): Promise<void> {
    await super.resolve();
    this.start();
  }

  /** Register a callback run at the start of `dispose()`, before the provider shuts down. */
  public onBeforeShutdown(hook: () => void): void {
    this.shutdownHooks.push(hook);
  }

  /**
   * Create the provider (idempotent, no-op when disabled). Call after the
   * Configuration service is resolved so the @Config fields are populated.
   */
  public start(processorOverride?: SpanProcessor): void {
    if (!this.enabled || this.provider) {
      return;
    }
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: this.serviceName,
      ...this.resourceAttributes,
    });
    const processor = processorOverride ?? new BatchSpanProcessor(new OTLPTraceExporter({ url: this.endpoint }));
    this.provider = new NodeTracerProvider({ resource, spanProcessors: [processor] });
    this.log.info({ serviceName: this.serviceName, endpoint: this.endpoint }, 'otel tracing started (service=${serviceName}, endpoint=${endpoint})');
  }

  public get active(): boolean {
    return this.provider !== undefined;
  }

  /** A tracer from the private provider, or the API no-op tracer when off. */
  public tracer(name: string): Tracer {
    return this.provider ? this.provider.getTracer(name) : this.noopProvider.getTracer(name);
  }

  /** Run `fn` inside a span; records exceptions and sets ERROR status on throw. */
  public async withSpan<T>(name: string, attrs: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.tracer('spinajs').startSpan(name, { attributes: attrs });
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  }

  public async flush(): Promise<void> {
    await this.provider?.forceFlush();
  }

  public async dispose(): Promise<void> {
    for (const hook of this.shutdownHooks.splice(0)) {
      try {
        hook();
      } catch (err) {
        this.log.warn({ error: err }, 'otel shutdown hook failed');
      }
    }
    await this.provider?.shutdown();
    this.provider = undefined;
    await super.dispose();
  }
}
