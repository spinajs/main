import { AsyncResource } from 'node:async_hooks';
import { Autoinject, Container, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Config, Configuration, registerConfigurationSchemaAtImport } from '@spinajs/configuration';
import { Log, Logger, PerfSink } from '@spinajs/log';
import type { IPerfMetric } from '@spinajs/log';
import { readTracingOptions } from '@spinajs/tracing';
import type { Attributes, Counter, Gauge, Histogram, Meter } from '@opentelemetry/api';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { MetricReader, PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export const PERF_METER_NAME = '@spinajs/perf';

const DEFAULT_ENDPOINT = 'https://otel.highlight.io:4318/v1/metrics';
const DEFAULT_EXPORT_INTERVAL_MS = 60_000;

// Perf labels are low-cardinality by contract (log-common IPerfMetric.labels); these bounds hold when a caller breaks it.
const MAX_INSTRUMENTS = 256;
const MAX_SERIES_PER_INSTRUMENT = 100;
const MAX_ATTRIBUTES = 8;
const MAX_ATTRIBUTE_LENGTH = 128;
const DROPPED_METRIC = 'spinajs.perf.dropped';
// One export, and the shutdown that waits for the last one: an unreachable collector holds the process this long at most.
const EXPORT_TIMEOUT_MS = 5_000;

const METRICS_CONFIGURATION_SCHEMA = {
  $id: 'spinajs/otel-metrics.configuration.schema.json',
  $configurationModule: 'otel.metrics',
  description: 'OtelPerfSink: Perf metrics over OTLP/HTTP (otel.metrics.*)',
  type: 'object',
  properties: {
    enabled: { type: 'boolean', default: false, description: 'Export every Perf measurement as an OpenTelemetry metric' },
    endpoint: { type: 'string', pattern: '^https?://', default: DEFAULT_ENDPOINT, description: 'Full OTLP/HTTP metrics URL (http: or https:), path included' },
    exportIntervalMs: { type: 'integer', minimum: 1000, default: DEFAULT_EXPORT_INTERVAL_MS, description: 'Milliseconds between two exports' },
  },
};

registerConfigurationSchemaAtImport(METRICS_CONFIGURATION_SCHEMA);

// The reader's timer and sockets keep the async context they are created in, and the first measurement usually runs
// inside a request: without this scope every export would pin that request's stores for the life of the process.
const PROCESS_SCOPE = new AsyncResource('OtelPerfSink');

/**
 * Every Perf measurement as an OpenTelemetry instrument named after it: a counter for Perf.count, a histogram in ms for
 * Perf.measure and Perf.start, a gauge for Perf.value. Only the labels are exported, never `fields`, `requestId` or
 * `error`. Off unless otel.metrics.enabled. `@spinajs/tracing` has no meter provider, so the sink keeps its own and never
 * registers it globally.
 */
@Singleton()
@Injectable(PerfSink)
export class OtelPerfSink extends PerfSink {
  @Logger('otel')
  protected log!: Log;

  @Config('otel.metrics.enabled', { defaultValue: false })
  protected enabled!: boolean;

  @Config('otel.metrics.endpoint', { defaultValue: DEFAULT_ENDPOINT })
  protected endpoint!: string;

  @Config('otel.metrics.exportIntervalMs', { defaultValue: DEFAULT_EXPORT_INTERVAL_MS })
  protected exportIntervalMs!: number;

  // The container, not the Configuration: Perf resolves its sinks synchronously, and Configuration is an AsyncService.
  @Autoinject(Container)
  protected Container!: IContainer;

  private provider?: MeterProvider;
  private meter?: Meter;
  private dropped?: Counter;
  // Perf keeps its sink list after the container disposed it, and services disposed later still emit.
  private disposed = false;
  // Decided at the first measurement after the Configuration resolved; a @Config read on every Perf event costs ~1 µs.
  private settled = false;
  // An exporter that cannot be built for the endpoint fails the same way on every metric: logged once, not retried.
  private exporterFailed = false;
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, Gauge>();

  public get active(): boolean {
    return this.provider !== undefined;
  }

  /** Creates the provider when enabled; idempotent. A test passes its own reader instead of the OTLP exporter. */
  public start(reader?: MetricReader): void {
    if (this.settled || this.disposed || this.exporterFailed) return;
    // Read before the @Config getters, which throw while no Configuration is resolved.
    const configuration = this.Container.get(Configuration);
    if (!configuration) return;
    this.settled = true;
    if (!this.enabled) return;
    PROCESS_SCOPE.runInAsyncScope(() => this.open(configuration, reader));
  }

  public collect(metric: IPerfMetric): void {
    if (this.meter === undefined) this.start();
    const meter = this.meter;
    if (meter === undefined) return;
    const value = metric.kind === 'span' ? (metric.durationMs ?? 0) : (metric.value ?? (metric.kind === 'counter' ? 1 : undefined));
    if (value === undefined) return;
    // OpenTelemetry drops a negative counter delta with a diagnostic only; counted here instead.
    if (!Number.isFinite(value) || (metric.kind === 'counter' && value < 0)) {
      this.drop('value');
      return;
    }
    const instrument = this.instrumentFor(meter, metric);
    if (instrument === undefined) {
      this.drop('instruments');
      return;
    }
    const attributes = boundedAttributes(metric.labels);
    if ('add' in instrument) instrument.add(value, attributes);
    else instrument.record(value, attributes);
  }

  public async flush(): Promise<void> {
    await this.provider?.forceFlush();
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const provider = this.provider;
    this.provider = undefined;
    this.meter = undefined;
    this.dropped = undefined;
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
    try {
      await provider?.shutdown({ timeoutMillis: EXPORT_TIMEOUT_MS });
    } catch (err) {
      // A collector that is down or slow fails the last export; the app's shutdown must go on.
      this.log.warn({ error: err }, 'otel metrics export: the metrics of the last interval were not exported');
    }
    await super.dispose();
  }

  private open(configuration: Configuration, reader: MetricReader | undefined): void {
    const exporting = reader ?? this.otlpReader();
    if (!exporting) return;
    // The resource of the traces (tracing.serviceName, tracing.resourceAttributes), so both signals name one service.
    const { serviceName, resourceAttributes } = readTracingOptions(configuration);
    this.provider = new MeterProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName, ...resourceAttributes }),
      readers: [exporting],
      views: [{ instrumentName: '*', aggregationCardinalityLimit: MAX_SERIES_PER_INSTRUMENT }],
    });
    this.meter = this.provider.getMeter(PERF_METER_NAME);
    this.dropped = this.meter.createCounter(DROPPED_METRIC, { description: 'Perf measurements OtelPerfSink did not export' });
    if (!reader) this.log.info({ endpoint: loggableEndpoint(this.endpoint) }, 'otel metrics export started (endpoint=${endpoint})');
  }

  private otlpReader(): MetricReader | undefined {
    try {
      // The exporter sends every scheme but http: as HTTPS to the URL's host and port.
      if (!/^https?:$/.test(new URL(this.endpoint).protocol)) throw new TypeError('not an http: or https: URL');
      const exportIntervalMillis = this.exportIntervalMs;
      return new PeriodicExportingMetricReader({
        exporter: new FailureLoggingExporter(new OTLPMetricExporter({ url: this.endpoint, timeoutMillis: EXPORT_TIMEOUT_MS }), (error) =>
          this.log.warn({ endpoint: loggableEndpoint(this.endpoint), reason: error?.message }, 'otel metrics export to ${endpoint} failed (${reason}); further failures are not logged until an export succeeds'),
        ),
        exportIntervalMillis,
        exportTimeoutMillis: Math.min(EXPORT_TIMEOUT_MS, exportIntervalMillis),
      });
    } catch {
      this.exporterFailed = true;
      // Not the error: its message repeats the endpoint as configured.
      this.log.error({ endpoint: loggableEndpoint(this.endpoint) }, 'otel metrics export not started: no OTLP exporter for ${endpoint}');
      return undefined;
    }
  }

  private instrumentFor(meter: Meter, metric: IPerfMetric): Counter | Histogram | Gauge | undefined {
    const { name } = metric;
    if (metric.kind === 'counter') return this.instrument(this.counters, name, () => meter.createCounter(name));
    if (metric.kind === 'span') return this.instrument(this.histograms, name, () => meter.createHistogram(name, { unit: 'ms' }));
    return this.instrument(this.gauges, name, () => meter.createGauge(name));
  }

  private instrument<I>(made: Map<string, I>, name: string, create: () => I): I | undefined {
    let instrument = made.get(name);
    if (instrument === undefined) {
      if (this.counters.size + this.histograms.size + this.gauges.size >= MAX_INSTRUMENTS) return undefined;
      instrument = create();
      made.set(name, instrument);
    }
    return instrument;
  }

  private drop(reason: 'instruments' | 'value'): void {
    this.dropped?.add(1, { reason });
  }
}

type ExportDone = Parameters<PushMetricExporter['export']>[1];

/** The SDK reports a failed export to the OpenTelemetry diagnostic logger only, which is silent unless an app installs one. */
class FailureLoggingExporter implements PushMetricExporter {
  public readonly selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  public readonly selectAggregation?: PushMetricExporter['selectAggregation'];
  private failing = false;

  constructor(
    private readonly inner: PushMetricExporter,
    private readonly onFirstFailure: (error: Error | undefined) => void,
  ) {
    this.selectAggregationTemporality = inner.selectAggregationTemporality?.bind(inner);
    this.selectAggregation = inner.selectAggregation?.bind(inner);
  }

  public export(metrics: ResourceMetrics, done: ExportDone): void {
    this.inner.export(metrics, (result) => {
      // 0 is ExportResultCode.SUCCESS of @opentelemetry/core, which this package does not depend on.
      if (result.code === 0) {
        this.failing = false;
      } else if (!this.failing) {
        this.failing = true;
        this.onFirstFailure(result.error);
      }
      done(result);
    });
  }

  public forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** The endpoint without userinfo and query, for logs. */
function loggableEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<not a URL>';
  }
}

const cut = (text: string): string => (text.length > MAX_ATTRIBUTE_LENGTH ? text.slice(0, MAX_ATTRIBUTE_LENGTH) : text);

const NO_ATTRIBUTES: Attributes = Object.freeze({});

function boundedAttributes(labels: IPerfMetric['labels']): Attributes {
  if (labels === undefined) return NO_ATTRIBUTES;
  const bounded = Object.entries(labels)
    .slice(0, MAX_ATTRIBUTES)
    .map(([key, value]): [string, string | number | boolean] => [cut(key), typeof value === 'string' ? cut(value) : value]);
  return Object.fromEntries(bounded);
}
