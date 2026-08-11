import 'mocha';
import { expect } from 'chai';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { SpanStatusCode } from '@opentelemetry/api';
import { OtelTracing } from '../src/tracing.js';
import { LongSpanRegistry } from '../src/longSpanRegistry.js';
import { setField } from './tracing.test.js';

const noopLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function makeRegistry(maxAgeMs = 60_000): { registry: LongSpanRegistry; exporter: InMemorySpanExporter; tracing: OtelTracing } {
  const tracing = new OtelTracing();
  setField(tracing, 'enabled', true);
  setField(tracing, 'serviceName', 'test');
  setField(tracing, 'resourceAttributes', {});
  setField(tracing, 'endpoint', 'http://localhost:4318/v1/traces');
  setField(tracing, 'log', noopLog);
  const exporter = new InMemorySpanExporter();
  tracing.start(new SimpleSpanProcessor(exporter));

  const registry = new LongSpanRegistry();
  setField(registry, 'tracing', tracing);
  setField(registry, 'log', noopLog);
  setField(registry, 'maxAgeMs', maxAgeMs);
  setField(registry, 'sweepIntervalMs', 3_600_000); // manual sweep in tests
  return { registry, exporter, tracing };
}

describe('LongSpanRegistry', () => {
  it('open + event + close exports one span with events and final attributes', () => {
    const { registry, exporter } = makeRegistry();
    registry.open('txn-1', 'payment.transaction', { 'transaction.id': 'txn-1' });
    expect(registry.has('txn-1')).to.eq(true);
    registry.event('txn-1', 'cash.inserted', { amount: 200 });
    registry.close('txn-1', 'ok', { state: 'completed' });
    expect(registry.has('txn-1')).to.eq(false);
    const spans = exporter.getFinishedSpans();
    expect(spans).to.have.length(1);
    expect(spans[0].name).to.eq('payment.transaction');
    expect(spans[0].events.map((e) => e.name)).to.deep.eq(['cash.inserted']);
    expect(spans[0].attributes.state).to.eq('completed');
    expect(spans[0].status.code).to.eq(SpanStatusCode.OK);
  });

  it('event/close/setAttributes on an unknown or undefined key are safe no-ops', () => {
    const { registry, exporter } = makeRegistry();
    registry.event(undefined, 'ignored');
    registry.event('nope', 'ignored');
    registry.setAttributes('nope', { a: 1 });
    registry.close('nope', 'ok');
    expect(exporter.getFinishedSpans()).to.have.length(0);
  });

  it('re-open on the same key closes the stale span as replaced', () => {
    const { registry, exporter } = makeRegistry();
    registry.open('txn-1', 'payment.transaction');
    registry.open('txn-1', 'payment.transaction');
    const finished = exporter.getFinishedSpans();
    expect(finished).to.have.length(1);
    expect(finished[0].attributes.replaced).to.eq(true);
    expect(finished[0].status.code).to.eq(SpanStatusCode.ERROR);
    registry.close('txn-1', 'ok');
  });

  it('sweep force-closes spans older than maxAgeMs as orphaned', () => {
    const { registry, exporter } = makeRegistry(0); // everything is immediately too old
    registry.open('txn-old', 'payment.transaction');
    registry.sweep();
    const spans = exporter.getFinishedSpans();
    expect(spans).to.have.length(1);
    expect(spans[0].attributes.orphaned).to.eq(true);
    expect(spans[0].status.code).to.eq(SpanStatusCode.ERROR);
    expect(registry.has('txn-old')).to.eq(false);
  });

  it('childSpan parents the child into the open root span', async () => {
    const { registry, exporter } = makeRegistry();
    registry.open('txn-1', 'payment.transaction');
    await registry.childSpan('txn-1', 'tcp.command', { command: 'enableAcceptors' }, async () => undefined);
    registry.close('txn-1', 'ok');
    const spans = exporter.getFinishedSpans();
    const child = spans.find((s) => s.name === 'tcp.command');
    const root = spans.find((s) => s.name === 'payment.transaction');
    expect(child).to.not.eq(undefined);
    expect(child!.parentSpanContext?.spanId).to.eq(root!.spanContext().spanId);
  });

  it('childSpan without a key still records a standalone span', async () => {
    const { registry, exporter } = makeRegistry();
    await registry.childSpan(undefined, 'tcp.command', { command: 'refill' }, async () => undefined);
    expect(exporter.getFinishedSpans()).to.have.length(1);
  });

  it('dispose closes all remaining spans', async () => {
    const { registry, exporter } = makeRegistry();
    registry.open('txn-1', 'payment.transaction');
    registry.open('txn-2', 'payment.transaction');
    await registry.dispose();
    expect(exporter.getFinishedSpans()).to.have.length(2);
    expect(registry.has('txn-1')).to.eq(false);
  });
});
