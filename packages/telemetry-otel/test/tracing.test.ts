import 'mocha';
import { expect } from 'chai';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { DEFAULT_TRACING_OPTIONS, ensureTracing } from '@spinajs/tracing';
import { resetTracing } from '@spinajs/tracing/testing';

import { makeTracing } from './support.js';

describe('OtelTracing', () => {
  beforeEach(() => {
    ensureTracing({ ...DEFAULT_TRACING_OPTIONS, serviceName: 'test-service', resourceAttributes: { 'highlight.project_id': 'test-project' } });
  });

  afterEach(() => resetTracing());

  it('records spans through withSpan when enabled', async () => {
    const { tracing, exporter } = makeTracing(true);
    const result = await tracing.withSpan('unit.op', { foo: 'bar' }, async () => 42);
    expect(result).to.eq(42);
    await tracing.flush();
    const spans = exporter.getFinishedSpans();
    expect(spans).to.have.length(1);
    expect(spans[0].name).to.eq('unit.op');
    expect(spans[0].attributes.foo).to.eq('bar');
    expect(spans[0].resource.attributes['service.name']).to.eq('test-service');
    expect(spans[0].resource.attributes['highlight.project_id']).to.eq('test-project');
    await tracing.dispose();
  });

  it('marks the span as error when the callback throws', async () => {
    const { tracing, exporter } = makeTracing(true);
    try {
      await tracing.withSpan('unit.fail', {}, async () => {
        throw new Error('boom');
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).to.eq('boom');
    }
    await tracing.flush();
    expect(exporter.getFinishedSpans()[0].status.code).to.eq(SpanStatusCode.ERROR);
    await tracing.dispose();
  });

  it('is inert when disabled', async () => {
    const { tracing, exporter } = makeTracing(false);
    expect(tracing.active).to.eq(false);
    const result = await tracing.withSpan('unit.noop', {}, async () => 'ok');
    expect(result).to.eq('ok');
    expect(exporter.getFinishedSpans()).to.have.length(0);
    await tracing.dispose();
  });

  it('stays a no-op when disabled even if another library registered a global provider', async () => {
    await resetTracing();
    const globalExporter = new InMemorySpanExporter();
    const globalProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(globalExporter)] });
    trace.setGlobalTracerProvider(globalProvider);
    try {
      const { tracing } = makeTracing(false);
      await tracing.withSpan('unit.noop', {}, async () => 'ok');
      expect(globalExporter.getFinishedSpans()).to.have.length(0);
    } finally {
      trace.disable();
    }
  });
});
