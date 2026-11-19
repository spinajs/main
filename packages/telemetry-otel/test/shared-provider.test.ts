import 'mocha';
import { expect } from 'chai';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SpanKind, trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { DEFAULT_TRACING_OPTIONS, ensureTracing, tracer, tracingState, withSpan } from '@spinajs/tracing';
import { resetTracing } from '@spinajs/tracing/testing';

import { OtelTracing } from '../src/tracing.js';
import { makeTracing, setField, silentLog } from './support.js';

function hubSize(): number {
  const hub = tracingState().hub;
  if (!hub) throw new Error('tracing is not owned by spinajs');
  return hub.size;
}

describe('OtelTracing on the shared provider', () => {
  afterEach(() => resetTracing());

  it('exports framework spans, not only its own withSpan spans', async () => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'shared-test', resourceAttributes: { 'highlight.project_id': 'p' } });
    const { tracing, exporter } = makeTracing();

    await withSpan('GET /invoices', { kind: SpanKind.SERVER }, () => tracing.withSpan('unit.op', {}, async () => 1));
    await tracing.flush();

    const finished = exporter.getFinishedSpans();
    const [server] = finished.filter((s) => s.name === 'GET /invoices');
    const [unit] = finished.filter((s) => s.name === 'unit.op');
    expect(finished).to.have.length(2);
    expect(server.resource.attributes).to.include({ 'service.name': 'shared-test', 'highlight.project_id': 'p' });
    expect(unit.parentSpanContext?.spanId).to.equal(server.spanContext().spanId);
    await tracing.dispose();
  });

  it('detaches its processor on dispose and leaves the hub to others', async () => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'shared-test' });
    const before = hubSize();
    const { tracing, exporter } = makeTracing();
    expect(hubSize()).to.equal(before + 1);

    await tracing.dispose();
    await withSpan('after', {}, () => undefined);
    expect(hubSize()).to.equal(before);
    expect(exporter.getFinishedSpans()).to.have.length(0);
  });

  it('stays inactive when an external SDK owns tracing', async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'shared-test' });
    expect(tracingState().owner).to.equal('external');

    const { tracing } = makeTracing();
    expect(tracing.active).to.equal(false);
    await tracing.dispose();
    trace.disable();
  });

  it('warns once about the removed otel.serviceName and otel.resourceAttributes and does not use their values', async () => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'shared-test' });
    const { tracing, exporter, warnings } = makeTracing(true, { 'otel.serviceName': 'legacy', 'otel.resourceAttributes': { a: '1' } });
    tracing.start();

    await tracing.withSpan('unit.op', {}, async () => 1);
    await tracing.flush();

    expect(warnings).to.deep.equal([{ removed: 'otel.serviceName, otel.resourceAttributes' }]);
    const [span] = exporter.getFinishedSpans();
    expect(span.resource.attributes['service.name']).to.equal('shared-test');
    expect(span.resource.attributes).to.not.have.property('a');
    await tracing.dispose();
  });

  it('does not warn when neither removed key is set', async () => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'shared-test' });
    const { tracing, warnings } = makeTracing(true, { 'otel.endpoint': 'http://localhost:4318/v1/traces' });

    expect(warnings).to.deep.equal([]);
    await tracing.dispose();
  });

  it('warns about the removed keys once also when the export cannot start and start() is called again', async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'shared-test' });
    const { tracing, warnings } = makeTracing(true, { 'otel.serviceName': 'legacy' });
    tracing.start();
    tracing.start();

    expect(tracing.active).to.equal(false);
    expect(warnings.filter((w) => 'removed' in w)).to.deep.equal([{ removed: 'otel.serviceName' }]);
    expect(warnings.filter((w) => 'reason' in w)).to.have.length(3);
    await tracing.dispose();
    trace.disable();
  });
});

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string };
}

interface OtlpRequest {
  resourceSpans: { resource: { attributes: OtlpAttribute[] }; scopeSpans: { spans: { name: string }[] }[] }[];
}

interface FakeCollector {
  url: string;
  requests: OtlpRequest[];
  /** Settles once the collector has read the body of its first request. */
  firstRequest: Promise<void>;
  close(): Promise<void>;
}

/** An in-process OTLP/HTTP receiver on loopback. `answer: false` reads each request and never responds. */
async function startCollector(answer: boolean): Promise<FakeCollector> {
  const requests: OtlpRequest[] = [];
  let received: () => void = () => undefined;
  const firstRequest = new Promise<void>((resolve) => {
    received = resolve;
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpRequest);
      received();
      if (answer) res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    requests,
    firstRequest,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const exportedSpans = (requests: OtlpRequest[]): string[] => requests.flatMap((r) => r.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((s) => s.spans.map((span) => span.name))));

/** Started without a processor override, so spans go through the default batch processor and OTLP exporter. */
function startOtlpExport(endpoint: string): { tracing: OtelTracing; warnings: Record<string, unknown>[]; errors: Record<string, unknown>[] } {
  const tracing = new OtelTracing();
  const warnings: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  setField(tracing, 'enabled', true);
  setField(tracing, 'endpoint', endpoint);
  setField(tracing, 'log', { ...silentLog, warn: (fields: Record<string, unknown>) => void warnings.push(fields), error: (fields: Record<string, unknown>) => void errors.push(fields) });
  setField(tracing, 'cfg', { get: (_path: string, fallback?: unknown) => fallback });
  tracing.start();
  return { tracing, warnings, errors };
}

describe('OtelTracing export to an OTLP collector', () => {
  // Read by the exporter and the batch processor when start() builds them. A batch of 10 and a queue of 20 make the
  // queue bound observable with a few spans; the resource variables must not reach the exported resource.
  const env = {
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '300',
    OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '10',
    OTEL_BSP_MAX_QUEUE_SIZE: '20',
    OTEL_SERVICE_NAME: 'from-env',
    OTEL_RESOURCE_ATTRIBUTES: 'host.name=from-env',
  };

  let saved: [string, string | undefined][] = [];

  beforeEach(() => {
    saved = Object.keys(env).map((key) => [key, process.env[key]]);
    Object.assign(process.env, env);
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'shared-test', resourceAttributes: { 'deployment.environment.name': 'test' } });
  });

  afterEach(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await resetTracing();
  });

  it('sends the shared spans with the resource of tracing.* only', async () => {
    const collector = await startCollector(true);
    const { tracing } = startOtlpExport(collector.url);

    await withSpan('GET /invoices', { kind: SpanKind.SERVER }, () => tracing.withSpan('unit.op', {}, async () => 1));
    await tracing.flush();

    const [request] = collector.requests;
    const { attributes } = request.resourceSpans[0].resource;
    expect(attributes.map((a) => a.key).sort()).to.deep.equal(['deployment.environment.name', 'service.name']);
    expect(attributes.find((a) => a.key === 'service.name')?.value.stringValue).to.equal('shared-test');
    expect(exportedSpans(collector.requests).sort()).to.deep.equal(['GET /invoices', 'unit.op']);
    await tracing.dispose();
    await collector.close();
  });

  it('ends spans without waiting for a collector that does not answer, drops what the queue cannot hold, and disposes', async () => {
    const collector = await startCollector(false);
    const { tracing, warnings } = startOtlpExport(collector.url);

    for (let i = 0; i < 150; i++) tracer().startSpan(`unit.${i}`).end();
    await collector.firstRequest;
    await tracing.dispose();

    // One batch in flight plus a full queue; the other spans were dropped, not buffered.
    expect(exportedSpans(collector.requests).length).to.be.within(1, 30);
    expect(warnings.filter((w) => 'error' in w)).to.have.length(1);
    expect(tracing.active).to.equal(false);
    await collector.close();
  });

  it('disposes without throwing when the collector is down', async () => {
    const collector = await startCollector(true);
    await collector.close();
    const { tracing, warnings } = startOtlpExport(collector.url);

    await withSpan('GET /invoices', {}, () => undefined);
    await tracing.dispose();

    expect(warnings.filter((w) => 'error' in w)).to.have.length(1);
    expect(tracing.active).to.equal(false);
  });

  it('stays inactive and logs when the exporter cannot be built from otel.endpoint', async () => {
    const { tracing, errors } = startOtlpExport('not a url');

    expect(tracing.active).to.equal(false);
    expect(errors).to.have.length(1);
    await withSpan('GET /invoices', {}, () => undefined);
    await tracing.dispose();
  });
});
