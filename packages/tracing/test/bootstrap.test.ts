import 'mocha';
import { expect } from 'chai';
import { trace } from '@opentelemetry/api';
import type { ProxyTracerProvider } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { configurationViolations, createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';

import { DEFAULT_TRACING_OPTIONS, TRACING_CONFIGURATION_SCHEMA, ensureTracing, tracer, tracingState } from '../src/index.js';
import type { SpanProcessorHub } from '../src/index.js';
import { resetTracing, useInMemorySpans } from '../src/testing.js';

const delegate = () => (trace.getTracerProvider() as ProxyTracerProvider).getDelegate();

describe('TracingBootstrapper', function () {
  this.timeout(15000);

  describe('with tracing.* configured', () => {
    let app: TestApp;

    before(async () => {
      await resetTracing();
      app = await createTestApp({ config: { tracing: { serviceName: 'svc-a', resourceAttributes: { 'deployment.environment.name': 'test' } } } });
    });

    after(async () => {
      await app.dispose();
      await resetTracing();
    });

    it('registers the Spina provider once Configuration is resolved', () => {
      expect(tracingState().owner).to.eq('spinajs');
      expect(delegate()).to.be.instanceOf(BasicTracerProvider);
    });

    it('puts service.name and the resource attributes on every span', async () => {
      const spans = useInMemorySpans();
      tracer().startSpan('resource').end();
      const [span] = spans.byName('resource');
      expect(span.resource.attributes).to.include({ 'service.name': 'svc-a', 'deployment.environment.name': 'test' });
      await spans.detach();
    });

    it('exports through a processor attached to the hub, and nothing after detach', async () => {
      const hub = tracingState().hub as SpanProcessorHub;
      const exporter = new InMemorySpanExporter();
      const detach = hub.add(new SimpleSpanProcessor(exporter));
      tracer().startSpan('exported').end();
      expect(exporter.getFinishedSpans().map((s) => s.name)).to.deep.eq(['exported']);

      // detach() shuts the processor down, which also clears the exporter.
      await detach();
      expect(hub.size).to.eq(0);
      tracer().startSpan('dropped').end();
      expect(exporter.getFinishedSpans()).to.deep.eq([]);
    });

    it('is idempotent', () => {
      const first = tracingState();
      expect(ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'other' })).to.eq(first);
    });
  });

  describe('with tracing.enabled false', () => {
    let app: TestApp;

    before(async () => {
      await resetTracing();
      app = await createTestApp({ config: { tracing: { enabled: false } } });
    });

    after(() => app.dispose());

    it('registers nothing, so spans are the API no-op', () => {
      expect(tracingState().owner).to.eq('none');
      expect(tracer().startSpan('off').spanContext().traceId).to.eq('00000000000000000000000000000000');
    });
  });

  // The Configuration resolves in the child, so the di.resolved.Configuration event is the child's; no test helper
  // calls ensureTracing here, the Bootstrapper must.
  describe('in a child container', () => {
    let app: TestApp;

    before(async () => {
      await resetTracing();
      app = await createTestApp({ scope: 'child', config: { tracing: { serviceName: 'svc-child' } } });
    });

    after(async () => {
      await app.dispose();
      await resetTracing();
    });

    it('starts tracing from the di.resolved.Configuration event of that container', () => {
      expect(tracingState().owner).to.eq('spinajs');
    });
  });

  describe('schema', () => {
    it('fills the defaults', async () => {
      const app = await createTestApp({ scope: 'child', bootstrap: false, schemas: [TRACING_CONFIGURATION_SCHEMA], config: {} });
      expect(app.config.get('tracing.enabled')).to.eq(true);
      expect(app.config.get('tracing.sampler')).to.deep.eq({ type: 'parent-ratio', ratio: 1 });
      await app.dispose();
    });

    it('refuses an unknown sampler type', async () => {
      const paths = await configurationViolations({ schemas: [TRACING_CONFIGURATION_SCHEMA], config: { tracing: { sampler: { type: 'sometimes' } } } });
      expect(paths.some((p) => p.startsWith('tracing.sampler'))).to.eq(true, JSON.stringify(paths));
    });
  });
});
