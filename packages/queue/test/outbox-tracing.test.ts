import 'mocha';
import { expect } from 'chai';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span, SpanContext } from '@opentelemetry/api';
import { DI } from '@spinajs/di';
import { withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { OutboxRelay, QueueHeaders, withConsumerSpan, type IQueueOutboxConfig } from '../src/index.js';
import { bootOutbox, broker, disposeOutbox, OrderPlaced, outboxRows, T0 } from './support/outbox-env.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
const TWO_BUSES = { OrderPlaced: [{ connection: 'bus-a' }, { connection: 'bus-b' }] };
const FIXED: Partial<IQueueOutboxConfig> = { backoff: { backoff: 'fixed', delay: 1000 } };

const relay = () => DI.resolve(OutboxRelay, [{ replicaId: 'r1', autoStart: false, random: () => 0.5 }]);

class BrokerDown extends Error {}

/** The version, trace id and span id of a `traceparent`, or of the context a span writes into one. */
function idsOf(source: string | null | undefined | Pick<Span, 'spanContext'>): string[] {
  if (source === null || source === undefined) return [];
  if (typeof source === 'string') return source.split('-').slice(0, 3);
  return ['00', source.spanContext().traceId, source.spanContext().spanId];
}

const idsOfContext = (sc: SpanContext): string[] => idsOf({ spanContext: () => sc });

/** An outbox emit relayed to `bus-a` and `bus-b` while `bus-b` refuses it once: the row and the sends that follow. */
async function relayFailingOnBusB() {
  const env = await bootOutbox({ outbox: FIXED, routing: TWO_BUSES });
  await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '6' })));
  broker.failures.set('bus-b', [new BrokerDown('bus-b is down')]);
  await (await relay()).tick();
  const [row] = await outboxRows(env.orders);
  const { Status, Attempts, AvailableAt, LastError, PublishedTo, ClaimedBy } = row;
  return { row: { Status, Attempts, AvailableAt, LastError, PublishedTo, ClaimedBy }, sentTo: broker.sent.map((s) => s.connection) };
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

    await (await relay()).tick();
    expect(broker.sent.map((s) => s.message.Headers?.traceparent)).to.deep.equal([row.TraceParent]);
  });

  it('relays a row under publish <Name>, a new trace linked to the create span, and leaves its trace headers alone', async () => {
    const env = await bootOutbox();
    await withSpan('POST /orders', { kind: SpanKind.SERVER }, () => env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '5' }))));
    let activeOnSend: SpanContext | undefined;
    broker.onEmit = () => (activeOnSend = trace.getActiveSpan()?.spanContext());
    await (await relay()).tick();

    expect(producers().map((s) => s.name)).to.deep.equal(['create OrderPlaced', 'publish OrderPlaced']);
    const [create, publish] = producers();
    expect(publish.parentSpanContext).to.equal(undefined);
    expect(publish.spanContext().traceId).to.not.equal(create.spanContext().traceId);
    expect(publish.links.map((l) => idsOfContext(l.context))).to.deep.equal([idsOf(create)]);
    expect(publish.attributes).to.include({
      'messaging.system': 'spinajs',
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'publish',
      'messaging.destination.name': 'OrderPlaced',
      'messaging.message.id': broker.sent[0].message.MessageId,
    });
    expect(publish.status.code).to.equal(SpanStatusCode.UNSET);
    expect(activeOnSend && idsOfContext(activeOnSend)).to.deep.equal(idsOf(publish));

    const [sent] = broker.sent;
    expect(idsOf(sent.message.Headers?.traceparent)).to.deep.equal(idsOf(create));
    await withConsumerSpan(sent.message, () => Promise.resolve());
    const [process] = spans.byName('process OrderPlaced');
    expect(process.spanContext().traceId).to.equal(create.spanContext().traceId);
    expect(process.parentSpanContext?.spanId).to.equal(create.spanContext().spanId);
  });

  it('relays a row to several connections under one publish span', async () => {
    const env = await bootOutbox({ routing: TWO_BUSES });
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '9' })));
    await (await relay()).tick();

    const [create] = spans.byName('create OrderPlaced');
    expect(spans.byName('publish OrderPlaced')).to.have.length(1);
    expect(broker.sent.map((s) => [s.connection, idsOf(s.message.Headers?.traceparent)])).to.deep.equal([
      ['bus-a', idsOf(create)],
      ['bus-b', idsOf(create)],
    ]);
  });

  it('ends the publish span of a failed relay publish with the error class and fails the row as it does with tracing off', async () => {
    const traced = await relayFailingOnBusB();

    const failed = spans.byName('publish OrderPlaced');
    expect(failed).to.have.length(1);
    expect(failed[0].status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'BrokerDown' });
    expect(failed[0].attributes).to.include({ 'error.type': 'BrokerDown' });
    expect(traced).to.deep.equal({
      row: { Status: 'pending', Attempts: 1, AvailableAt: T0 + 1000, LastError: 'bus-b is down', PublishedTo: ['bus-a'], ClaimedBy: null },
      sentTo: ['bus-a'],
    });

    await spans.detach();
    await disposeOutbox();
    expect(await relayFailingOnBusB()).to.deep.equal(traced);
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

  it('relays the row with the trace headers the caller set and under no span', async () => {
    const env = await bootOutbox();
    const headers = { [QueueHeaders.TraceParent]: TRACEPARENT, tenant: 't1' };
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '10', Headers: headers })));
    let recordingOnSend: boolean | undefined;
    broker.onEmit = () => (recordingOnSend = trace.getActiveSpan()?.isRecording() ?? false);
    await (await relay()).tick();

    expect(broker.sent.map((s) => s.message.Headers)).to.deep.equal([headers]);
    expect(recordingOnSend).to.equal(false);
  });

  it('relays a row written without trace headers under a publish span without a link once tracing is on', async () => {
    const env = await bootOutbox();
    await env.orders.transaction(() => env.queue.emit(new OrderPlaced({ OrderId: '11' })));
    const [row] = await outboxRows(env.orders);
    expect(row.TraceParent ?? undefined).to.equal(undefined);

    const spans = useInMemorySpans();
    try {
      await (await relay()).tick();
      const [publish] = spans.byName('publish OrderPlaced');
      expect(publish.kind).to.equal(SpanKind.PRODUCER);
      expect(publish.parentSpanContext).to.equal(undefined);
      expect(publish.links).to.deep.equal([]);
      expect(broker.sent[0].message.Headers ?? {}).to.not.have.property(QueueHeaders.TraceParent);
    } finally {
      await spans.detach();
    }
  });
});
