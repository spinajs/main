import 'mocha';
import { expect } from 'chai';
import { SpanKind } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { DI } from '@spinajs/di';
import { withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { OutboxRelay, QueueHeaders } from '../src/index.js';
import { bootOutbox, broker, disposeOutbox, OrderPlaced, outboxRows } from './support/outbox-env.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** The version, trace id and span id of a `traceparent`, or of the context a span writes into one. */
function idsOf(source: string | null | undefined | Pick<Span, 'spanContext'>): string[] {
  if (source === null || source === undefined) return [];
  if (typeof source === 'string') return source.split('-').slice(0, 3);
  return ['00', source.spanContext().traceId, source.spanContext().spanId];
}

describe('queue outbox: emit spans', function () {
  // every case boots an Orm with three sqlite connections, which takes up to 30 s on a loaded machine
  this.timeout(120_000);

  let spans: InMemorySpans;

  beforeEach(() => {
    spans = useInMemorySpans();
  });

  afterEach(async () => {
    await spans.detach();
    await disposeOutbox();
  });

  const producers = () => spans.spans().filter((s) => s.kind === SpanKind.PRODUCER);

  it('traces an emit into the outbox as a PRODUCER span create <Name> whose context the row carries', async () => {
    const env = await bootOutbox();
    await withSpan('POST /orders', { kind: SpanKind.SERVER }, () => env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '1' }))));

    const [server] = spans.byName('POST /orders');
    const [create] = producers();
    expect(producers().map((s) => s.name)).to.deep.equal(['create OrderPlaced']);
    expect(create.parentSpanContext?.spanId).to.equal(server.spanContext().spanId);
    expect(create.attributes).to.include({
      'messaging.system': 'spinajs',
      'messaging.operation.type': 'create',
      'messaging.operation.name': 'create',
      'messaging.destination.name': 'OrderPlaced',
    });

    const [row] = await outboxRows(env.orders);
    expect(idsOf(row.TraceParent)).to.deep.equal(idsOf(create));
    expect(JSON.parse(row.Message)).to.have.nested.property('Headers.traceparent', row.TraceParent);
    expect(broker.sent).to.deep.equal([]);

    const relay = await DI.resolve(OutboxRelay, [{ replicaId: 'r1', autoStart: false }]);
    await relay.tick();
    expect(broker.sent.map((s) => s.message.Headers?.traceparent)).to.deep.equal([row.TraceParent]);
  });

  it('still traces an emit outside a transaction as publish <Name>', async () => {
    const env = await bootOutbox();
    await env.queue.emit(new OrderPlaced({ OrderId: '2' }));

    const [publish] = producers();
    expect(producers().map((s) => s.name)).to.deep.equal(['publish OrderPlaced']);
    expect(publish.attributes).to.include({
      'messaging.system': 'spinajs',
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'publish',
      'messaging.destination.name': 'OrderPlaced',
    });
    expect(broker.sent).to.have.length(1);
    expect(idsOf(broker.sent[0].message.Headers?.traceparent)).to.deep.equal(idsOf(publish));
  });
});

describe('queue outbox: emit while tracing is not started', function () {
  this.timeout(120_000);

  beforeEach(() => resetTracing());
  afterEach(disposeOutbox);

  it('keeps the trace headers the caller set on the outbox row', async () => {
    const env = await bootOutbox();
    const headers = { [QueueHeaders.TraceParent]: TRACEPARENT, tenant: 't1' };
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '3', Headers: headers })));

    const [row] = await outboxRows(env.orders);
    expect(row.TraceParent).to.equal(TRACEPARENT);
    expect(JSON.parse(row.Message)).to.have.deep.property('Headers', headers);
  });

  it('keeps the trace headers the caller set on a direct publish', async () => {
    const env = await bootOutbox();
    const headers = { [QueueHeaders.TraceParent]: TRACEPARENT, tenant: 't1' };
    await env.queue.emit(new OrderPlaced({ OrderId: '4', Headers: headers }));

    expect(broker.sent.map((s) => s.message.Headers)).to.deep.equal([headers]);
  });
});
