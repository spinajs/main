import 'mocha';
import { AsyncLocalStorage, createHook } from 'node:async_hooks';
import { createServer } from 'node:http';
import { expect } from 'chai';
import { AggregationTemporality, DataPointType, MetricReader, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import type { MetricData, PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { DI } from '@spinajs/di';
import { Perf } from '@spinajs/log';
import { OtelPerfSink } from '../src/perf-sink.js';
import { setField } from './support.js';

/** Collects on demand: what an exporter would receive, without a network. */
class TestReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

type ExportDone = Parameters<PushMetricExporter['export']>[1];

/** An exporter that never answers, throws, or reports a failure: a collector that hangs, is broken or refuses. */
class BrokenExporter implements PushMetricExporter {
  public calls = 0;
  constructor(private readonly mode: 'hang' | 'throw' | 'fail') {}
  public export(_metrics: ResourceMetrics, done: ExportDone): void {
    this.calls++;
    if (this.mode === 'throw') throw new Error('collector down');
    // 1 is ExportResultCode.FAILED of @opentelemetry/core, which this package does not depend on
    if (this.mode === 'fail') done({ code: 1, error: new Error('503') });
  }
  public async forceFlush(): Promise<void> {}
  public async shutdown(): Promise<void> {}
  public selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }
}

interface Logged {
  errors: Record<string, unknown>[];
  warnings: Record<string, unknown>[];
  /** Every log call of any level, fields and message, with an error's message spelled out. */
  text: () => string;
}

/**
 * Sets the DI-injected fields of a sink by hand, as support.ts does for OtelTracing, and starts it on a reader.
 * `config` holds the configuration paths that are set, by full path; any other path answers its fallback.
 */
function configure(sink: OtelPerfSink, enabled: boolean, config: Record<string, unknown> = { 'tracing.serviceName': 'test-service' }, reader: MetricReader | null = new TestReader()): Logged {
  const values = new Map(Object.entries(config));
  const configuration = { get: (path: string, fallback?: unknown) => (values.has(path) ? values.get(path) : fallback) };
  const calls: unknown[][] = [];
  const logged: Logged = { errors: [], warnings: [], text: () => JSON.stringify(calls, (_key, value: unknown) => (value instanceof Error ? `${value.name}: ${value.message}` : value)) };
  setField(sink, 'enabled', enabled);
  setField(sink, 'endpoint', values.get('otel.metrics.endpoint') ?? 'http://127.0.0.1:9/v1/metrics');
  setField(sink, 'exportIntervalMs', 60_000);
  setField(sink, 'log', {
    info: (...args: unknown[]) => void calls.push(args),
    error: (fields: Record<string, unknown>, ...rest: unknown[]) => void (logged.errors.push(fields), calls.push([fields, ...rest])),
    warn: (fields: Record<string, unknown>, ...rest: unknown[]) => void (logged.warnings.push(fields), calls.push([fields, ...rest])),
  });
  setField(sink, 'Container', { get: () => configuration });
  if (reader) sink.start(reader);
  return logged;
}

async function collected(reader: MetricReader): Promise<MetricData[]> {
  const { resourceMetrics } = await reader.collect();
  return resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
}

const isTimer = (resource: object): resource is NodeJS.Timeout => 'hasRef' in resource;
const named = (metrics: MetricData[], name: string): MetricData | undefined => metrics.find((metric) => metric.descriptor.name === name);
const points = (metric: MetricData | undefined): Array<{ attributes: Record<string, unknown>; value: unknown }> => [...(metric?.dataPoints ?? [])];

describe('OtelPerfSink', () => {
  it('turns a Perf counter into a monotonic counter per name, with its labels as attributes', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    sink.collect({ name: 'authz.cache.l2.hit', kind: 'counter', value: 1 });
    sink.collect({ name: 'authz.cache.l2.hit', kind: 'counter', value: 1 });
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1, labels: { cache: 'default', layer: 'orm' } });
    const metrics = await collected(reader);
    expect(named(metrics, 'authz.cache.l2.hit')).to.deep.include({ dataPointType: DataPointType.SUM, isMonotonic: true });
    expect(points(named(metrics, 'authz.cache.l2.hit')).map((p) => p.value)).to.deep.eq([2]);
    expect(points(named(metrics, 'cache.hit')).map((p) => [p.attributes, p.value])).to.deep.eq([[{ cache: 'default', layer: 'orm' }, 1]]);
    await sink.dispose();
  });

  it('turns a Perf span into a histogram in milliseconds', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    sink.collect({ name: 'cache.compute', kind: 'span', durationMs: 12, labels: { cache: 'default', layer: 'app' } });
    sink.collect({ name: 'cache.compute', kind: 'span', durationMs: 30, labels: { cache: 'default', layer: 'app' } });
    const compute = named(await collected(reader), 'cache.compute');
    expect(compute).to.deep.include({ dataPointType: DataPointType.HISTOGRAM });
    expect(compute?.descriptor.unit).to.eq('ms');
    expect(points(compute)[0].value).to.deep.include({ count: 2, sum: 42, min: 12, max: 30 });
    await sink.dispose();
  });

  it('turns a Perf value into a gauge holding the last value', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    sink.collect({ name: 'authn.throttle.db', kind: 'value', value: 5 });
    sink.collect({ name: 'authn.throttle.db', kind: 'value', value: 7 });
    const gauge = named(await collected(reader), 'authn.throttle.db');
    expect(gauge).to.deep.include({ dataPointType: DataPointType.GAUGE });
    expect(points(gauge).map((p) => p.value)).to.deep.eq([7]);
    await sink.dispose();
  });

  it('exports the labels only: never the fields, the request id or the error of a metric', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    const error = new Error('secret-binding-42');
    sink.collect({ name: 'orm.query', kind: 'span', durationMs: 3, labels: { driver: 'sqlite' }, fields: { sql: 'select 1', bindings: ['secret-binding-42'] }, requestId: 'req-1', error });
    const exported = JSON.stringify(await collected(reader));
    expect(points(named(await collected(reader), 'orm.query')).map((p) => p.attributes)).to.deep.eq([{ driver: 'sqlite' }]);
    expect(exported).to.not.contain('secret-binding-42');
    expect(exported).to.not.contain('select 1');
    expect(exported).to.not.contain('req-1');
    await sink.dispose();
  });

  it('bounds the attributes: at most 8 per measurement, a string value at most 128 characters', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    const labels = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i === 0 ? 'x'.repeat(500) : i]));
    sink.collect({ name: 'wide', kind: 'counter', value: 1, labels });
    const [point] = points(named(await collected(reader), 'wide'));
    expect(Object.keys(point.attributes)).to.have.length(8);
    expect(point.attributes.k0).to.eq('x'.repeat(128));
    await sink.dispose();
  });

  it('cuts an attribute key at 128 characters like a value', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    sink.collect({ name: 'long.key', kind: 'counter', value: 1, labels: { ['k'.repeat(500)]: 'v' } });
    const [point] = points(named(await collected(reader), 'long.key'));
    expect(Object.keys(point.attributes)).to.deep.eq(['k'.repeat(128)]);
    await sink.dispose();
  });

  it('bounds the series of one metric at 100: further label sets fold into the overflow series', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    for (let i = 0; i < 150; i++) sink.collect({ name: 'route.hit', kind: 'counter', value: 1, labels: { route: `/invoices/${i}` } });
    const series = points(named(await collected(reader), 'route.hit'));
    expect(series).to.have.length(100);
    expect(series.find((p) => p.attributes['otel.metric.overflow'] === true)?.value).to.eq(51);
    await sink.dispose();
  });

  it('keeps at most 256 metric names and counts what it drops', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    for (let i = 0; i < 260; i++) sink.collect({ name: `generated.${i}`, kind: 'counter', value: 1 });
    sink.collect({ name: 'generated.0', kind: 'counter', value: 1 });
    sink.collect({ name: 'negative', kind: 'counter', value: -1 });
    const metrics = await collected(reader);
    expect(metrics.filter((metric) => metric.descriptor.name.startsWith('generated.'))).to.have.length(256);
    expect(points(named(metrics, 'generated.0')).map((p) => p.value)).to.deep.eq([2]);
    const dropped = points(named(metrics, 'spinajs.perf.dropped')).map((p) => [p.attributes, p.value]);
    expect(dropped).to.deep.include.members([
      [{ reason: 'instruments' }, 4],
      [{ reason: 'value' }, 1],
    ]);
    await sink.dispose();
  });

  it('keeps spinajs.perf.dropped to its own reasons: a producer cannot write into it', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    sink.collect({ name: 'spinajs.perf.dropped', kind: 'counter', value: 1, labels: { reason: 'x' } });
    const dropped = points(named(await collected(reader), 'spinajs.perf.dropped')).map((p) => [p.attributes, p.value]);
    expect(dropped).to.deep.eq([[{ reason: 'instruments' }, 1]]);
    await sink.dispose();
  });

  it('names the service from tracing.*, as the traces do, and not from the removed otel.* keys', async () => {
    const sink = new OtelPerfSink();
    const reader = new TestReader();
    configure(
      sink,
      true,
      {
        'tracing.serviceName': 'billing',
        'tracing.resourceAttributes': { 'deployment.environment': 'test' },
        'otel.serviceName': 'old-name',
        'otel.resourceAttributes': { old: 'yes' },
      },
      reader,
    );
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    const { resourceMetrics } = await reader.collect();
    expect(resourceMetrics.resource.attributes).to.include({ 'service.name': 'billing', 'deployment.environment': 'test' });
    expect(resourceMetrics.resource.attributes).to.not.have.property('old');
    await sink.dispose();
  });

  it('does nothing while otel.metrics.enabled is false', () => {
    const sink = new OtelPerfSink();
    configure(sink, false);
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    expect(sink.active).to.eq(false);
  });

  it('decides once, at the first measurement after the Configuration resolved, and reads no configuration afterwards', () => {
    const sink = new OtelPerfSink();
    let reads = 0;
    const configuration = { get: (_path: string, fallback?: unknown) => fallback };
    setField(sink, 'Container', { get: () => (reads++, configuration) });
    Object.defineProperty(sink, 'enabled', { get: () => (reads++, false) });
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    const first = reads;
    for (let i = 0; i < 1000; i++) sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    expect(first).to.be.greaterThan(0);
    expect(reads).to.eq(first);
    expect(sink.active).to.eq(false);
  });

  it('does nothing and throws nothing while no Configuration is resolved', () => {
    const sink = new OtelPerfSink();
    setField(sink, 'Container', { get: () => null });
    // the getter of a @Config property throws without a Configuration; the sink must not read it then
    Object.defineProperty(sink, 'enabled', { get: () => expect.fail('otel.metrics.enabled read without a Configuration') });
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    expect(sink.active).to.eq(false);
  });

  it('stays inactive, logs once and does not throw when no OTLP exporter can be built for the endpoint', () => {
    const sink = new OtelPerfSink();
    const logged = configure(sink, true, { 'otel.metrics.endpoint': 'not a url' }, null);
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    expect(sink.active).to.eq(false);
    expect(logged.errors).to.have.length(1);
  });

  it('refuses an endpoint that is not http: or https:, which the exporter would send as HTTPS', () => {
    for (const endpoint of ['ftp://127.0.0.1:9/v1/metrics', 'ws://127.0.0.1:9/v1/metrics']) {
      const sink = new OtelPerfSink();
      const logged = configure(sink, true, { 'otel.metrics.endpoint': endpoint }, null);
      sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
      expect(sink.active).to.eq(false);
      expect(logged.errors).to.have.length(1);
    }
  });

  it('logs the endpoint without its userinfo and query string', () => {
    for (const endpoint of ['http://user:pw-secret@127.0.0.1:9/v1/metrics?token=q-secret', 'not a url user:pw-secret@host?token=q-secret']) {
      const sink = new OtelPerfSink();
      const logged = configure(sink, true, { 'otel.metrics.endpoint': endpoint }, null);
      sink.start();
      expect(logged.text()).to.contain('otel metrics export');
      expect(logged.text()).to.not.contain('pw-secret');
      expect(logged.text()).to.not.contain('q-secret');
      void sink.dispose();
    }
  });

  it('starts no export from the record path: exports run on the reader interval only', async () => {
    const sink = new OtelPerfSink();
    const exporter = new BrokenExporter('fail');
    configure(sink, true, undefined, new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60_000 }));
    for (let i = 0; i < 1000; i++) sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exporter.calls).to.eq(0);
    await sink.dispose();
  });

  for (const mode of ['hang', 'throw', 'fail'] as const) {
    it(`neither fails nor waits for an exporter that ${mode}s, and its dispose resolves`, async () => {
      const sink = new OtelPerfSink();
      const exporter = new BrokenExporter(mode);
      configure(sink, true, undefined, new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 5, exportTimeoutMillis: 5 }));
      const started = performance.now();
      for (let i = 0; i < 1000; i++) sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
      expect(performance.now() - started).to.be.below(250);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(exporter.calls).to.be.greaterThan(0);
      await sink.dispose();
      expect(sink.active).to.eq(false);
    });
  }

  it('exports in no request context, also when the first measurement came from a request', async () => {
    const als = new AsyncLocalStorage<{ request: string }>();
    const stores: unknown[] = [];
    const recording: PushMetricExporter = {
      export: (_metrics, done) => {
        stores.push(als.getStore());
        done({ code: 0 });
      },
      forceFlush: async () => undefined,
      shutdown: async () => undefined,
    };
    const sink = new OtelPerfSink();
    configure(sink, true, undefined, null);
    als.run({ request: 'req-of-tenant-A' }, () => {
      sink.start(new PeriodicExportingMetricReader({ exporter: recording, exportIntervalMillis: 5, exportTimeoutMillis: 5 }));
      sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await sink.dispose();
    expect(stores).to.not.be.empty;
    expect(stores.filter((store) => store !== undefined)).to.deep.eq([]);
  });

  it('logs the first failed export of an outage once, and again after an export succeeded', async () => {
    let status = 400;
    let requests = 0;
    const receiver = createServer((req, res) => {
      requests++;
      req.resume();
      req.on('end', () => res.writeHead(status).end());
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const until = async (done: () => boolean): Promise<void> => {
      while (!done()) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    try {
      const sink = new OtelPerfSink();
      const address = receiver.address();
      if (address === null || typeof address === 'string') throw new Error('the receiver has no port');
      const endpoint = `http://127.0.0.1:${address.port}/v1/metrics`;
      const logged = configure(sink, true, { 'otel.metrics.endpoint': endpoint }, null);
      setField(sink, 'exportIntervalMs', 20);
      sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
      await until(() => requests >= 4);
      expect(logged.warnings).to.have.length(1);
      status = 200;
      const answered = requests;
      await until(() => requests >= answered + 2);
      status = 400;
      await until(() => logged.warnings.length === 2);
      await sink.dispose();
      expect(logged.warnings[0]).to.deep.include({ endpoint });
    } finally {
      await new Promise((resolve) => receiver.close(resolve));
    }
  });

  it('shuts its provider down on dispose, and a metric that arrives afterwards does not start another', async () => {
    const sink = new OtelPerfSink();
    configure(sink, true);
    expect(sink.active).to.eq(true);
    await sink.dispose();
    expect(sink.active).to.eq(false);
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    expect(sink.active).to.eq(false);
  });

  it('holds nothing that keeps the process alive, while it exports and after dispose', async () => {
    // Mocha arms this test's own timeout once the function returned its promise, so the hook starts after that.
    await new Promise((resolve) => setImmediate(resolve));
    // the timers and sockets created from here on; destroy fires when a timer is cleared or has run, a socket closed
    const live = new Map<number, { type: string; resource: object }>();
    const hook = createHook({
      init: (id, type, _trigger, resource) => {
        if (['Timeout', 'TCPWRAP', 'TCPCONNECTWRAP'].includes(type)) live.set(id, { type, resource });
      },
      destroy: (id) => live.delete(id),
    }).enable();
    try {
      const sink = new OtelPerfSink();
      configure(sink, true, undefined, null);
      sink.start();
      sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
      expect(sink.active).to.eq(true);
      expect([...live.values()].map(({ type, resource }) => [type, isTimer(resource) && resource.hasRef()])).to.deep.eq([['Timeout', false]]);
      await sink.dispose();
      // the last export went to a closed port; its socket closes a few turns after the refusal
      await new Promise((resolve) => setTimeout(resolve, 100));
      await new Promise((resolve) => setImmediate(resolve));
      expect([...live.values()].map(({ type }) => type)).to.deep.eq([]);
    } finally {
      hook.disable();
    }
  });

  it('stops exporting on dispose, and a second dispose is harmless', async () => {
    const sink = new OtelPerfSink();
    const exporter = new BrokenExporter('fail');
    configure(sink, true, undefined, new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 5, exportTimeoutMillis: 5 }));
    sink.collect({ name: 'cache.hit', kind: 'counter', value: 1 });
    await sink.dispose();
    await sink.dispose();
    const calls = exporter.calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exporter.calls).to.eq(calls);
  });

  it('receives what Perf.count emits, as every registered PerfSink does', async () => {
    const sink = DI.resolve(OtelPerfSink);
    const reader = new TestReader();
    configure(sink, true, undefined, reader);
    Perf.refreshSinks();
    try {
      Perf.count('authz.cache.l2.hit');
      expect(points(named(await collected(reader), 'authz.cache.l2.hit')).map((p) => p.value)).to.deep.eq([1]);
    } finally {
      await sink.dispose();
      setField(sink, 'enabled', false);
      Perf.refreshSinks();
    }
  });
});
