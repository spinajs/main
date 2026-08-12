import 'mocha';
import { expect } from 'chai';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { OtelTracing } from '../src/tracing.js';

/**
 * Shadow a @Config/@Logger prototype getter with an own value property — the
 * decorators define getter-only accessors, so a plain assignment throws.
 */
export function setField(obj: object, key: string, value: unknown): void {
  Object.defineProperty(obj, key, { value, writable: true, configurable: true });
}

/** Build an OtelTracing with DI-injected fields set manually (no container). */
function makeTracing(enabled: boolean): { tracing: OtelTracing; exporter: InMemorySpanExporter } {
  const tracing = new OtelTracing();
  setField(tracing, 'enabled', enabled);
  setField(tracing, 'endpoint', 'http://localhost:4318/v1/traces');
  setField(tracing, 'serviceName', 'test-service');
  setField(tracing, 'resourceAttributes', { 'highlight.project_id': 'test-project' });
  setField(tracing, 'log', { info: () => undefined, warn: () => undefined, error: () => undefined });
  const exporter = new InMemorySpanExporter();
  tracing.start(new SimpleSpanProcessor(exporter));
  return { tracing, exporter };
}

describe('OtelTracing', () => {
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
});
