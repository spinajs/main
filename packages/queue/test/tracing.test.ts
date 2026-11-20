import 'mocha';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { DI } from '@spinajs/di';
import { withSpan } from '@spinajs/tracing';
import { resetTracing, useInMemorySpans } from '@spinajs/tracing/testing';
import type { InMemorySpans } from '@spinajs/tracing/testing';

import { Event, isScheduledDelivery, QueueEvent, QueueMessageType, QueueService } from '../src/index.js';
import type { IQueueMessage } from '../src/index.js';
import { MemoryBroker } from '../src/testing/index.js';
import { bootClient, brokerName } from './support/memory-harness.js';

@Event()
class TracedPing extends QueueEvent {}

class HandlerFailed extends Error {}

const ping = (extra: Partial<IQueueMessage> = {}): IQueueMessage => ({ Name: 'TracedPing', Type: QueueMessageType.Event, CreatedAt: DateTime.now(), Persistent: false, Priority: 0, ...extra });

describe('queue trace propagation', function () {
  this.timeout(15000);

  let spans: InMemorySpans;
  let broker: string;

  beforeEach(() => {
    spans = useInMemorySpans();
    broker = brokerName('tracing');
  });

  afterEach(async () => {
    await spans.detach();
    await DI.dispose();
    DI.clearCache();
    MemoryBroker.drop(broker);
  });

  // the outbox and transport suites of this package pass their own traceparent header through emit
  after(() => resetTracing());

  async function boot() {
    const client = await bootClient({ broker, deferred: true });
    const queue = await DI.resolve(QueueService);
    const handled: TracedPing[] = [];
    await queue.consume(TracedPing, async (m: TracedPing) => void handled.push(m));
    return { client, queue, handled };
  }

  it('publishes as a PRODUCER child of the active span and processes as a CONSUMER child of publish', async () => {
    const { client, queue, handled } = await boot();
    await withSpan('POST /invoices', { kind: SpanKind.SERVER }, () => queue.emit(ping()));
    await client.deliverAll();

    expect(handled).to.have.length(1);
    const [server] = spans.byName('POST /invoices');
    const [publish] = spans.byName('publish TracedPing');
    const [process] = spans.byName('process TracedPing');
    expect(publish.kind).to.equal(SpanKind.PRODUCER);
    expect(publish.parentSpanContext?.spanId).to.equal(server.spanContext().spanId);
    expect(publish.attributes).to.include({ 'messaging.system': 'spinajs', 'messaging.operation.type': 'send', 'messaging.destination.name': 'TracedPing' });
    expect(process.kind).to.equal(SpanKind.CONSUMER);
    expect(process.parentSpanContext?.spanId).to.equal(publish.spanContext().spanId);
    expect(process.spanContext().traceId).to.equal(server.spanContext().traceId);
    expect(handled[0].Headers?.traceparent).to.match(new RegExp(`^00-${server.spanContext().traceId}-${publish.spanContext().spanId}-0[01]$`));
  });

  it('starts a new trace for a message without trace headers', async () => {
    const { client, handled } = await boot();
    await client.emit(ping());
    await client.deliverAll();

    expect(handled).to.have.length(1);
    expect(spans.byName('process TracedPing')[0].parentSpanContext).to.equal(undefined);
  });

  it('delivers a message whose traceparent is malformed, on a new trace', async () => {
    const { client, handled } = await boot();
    await client.emit(ping({ Headers: { traceparent: 'not-a-traceparent' } }));
    await client.deliverAll();

    expect(handled).to.have.length(1);
    expect(spans.byName('process TracedPing')[0].parentSpanContext).to.equal(undefined);
  });

  it('replaces the trace headers of a received message emitted again and keeps the others', async () => {
    const { client, queue } = await boot();
    const stale = '00-11111111111111111111111111111111-2222222222222222-01';
    await withSpan('job', {}, () => queue.emit(ping({ Headers: { traceparent: stale, tracestate: 'old=1', tenant: 't1' } })));

    const sent = client.published[client.published.length - 1];
    expect(sent.Headers?.traceparent).to.not.equal(stale);
    expect(sent.Headers?.tenant).to.equal('t1');
    expect(sent.Headers).to.not.have.property('tracestate');
  });

  it('marks the process span ERROR when the handler throws', async () => {
    const client = await bootClient({ broker, deferred: true });
    const queue = await DI.resolve(QueueService);
    await queue.consume(TracedPing, () => Promise.reject(new HandlerFailed('handler failed, params: secret-binding-42')));
    await queue.emit(ping());
    await client.deliverAll();

    const [process] = spans.byName('process TracedPing');
    expect(process.status).to.deep.equal({ code: SpanStatusCode.ERROR, message: 'HandlerFailed' });
    expect(JSON.stringify({ status: process.status, attributes: process.attributes, events: process.events })).to.not.contain('secret-binding-42');
  });

  for (const [what, schedule] of [
    ['a cron message', { ScheduleCron: '* * * * *' }],
    ['a repeating message', { SchedulePeriod: 60_000, ScheduleRepeat: 3 }],
    ['a delayed message', { ScheduleDelay: 5_000 }],
  ] as const) {
    it(`processes ${what} as the root of a new trace linked to its publish span`, async () => {
      const { client, queue, handled } = await boot();
      await withSpan('POST /reports', { kind: SpanKind.SERVER }, () => queue.emit(ping(schedule)));
      await client.deliverAll();

      expect(handled).to.have.length(1);
      const [publish] = spans.byName('publish TracedPing');
      const [process] = spans.byName('process TracedPing');
      expect(process.parentSpanContext).to.equal(undefined);
      expect(process.spanContext().traceId).to.not.equal(publish.spanContext().traceId);
      expect(process.links.map((l) => [l.context.traceId, l.context.spanId])).to.deep.equal([[publish.spanContext().traceId, publish.spanContext().spanId]]);
    });
  }

  it('reads a zero delay and an empty cron as an ordinary message', () => {
    expect(isScheduledDelivery(ping({ ScheduleDelay: 0, ScheduleCron: '' }))).to.equal(false);
    expect(isScheduledDelivery(ping({ ScheduleRepeat: 1 }))).to.equal(true);
  });
});

describe('queue emit while tracing is not started', () => {
  let broker: string;

  beforeEach(async () => {
    await resetTracing();
    broker = brokerName('tracing-off');
  });

  afterEach(async () => {
    await DI.dispose();
    DI.clearCache();
    MemoryBroker.drop(broker);
  });

  it('leaves the trace headers the caller set as they are', async () => {
    const client = await bootClient({ broker, deferred: true });
    const queue = await DI.resolve(QueueService);
    const headers = { traceparent: '00-11111111111111111111111111111111-2222222222222222-01', tenant: 't1' };
    await queue.emit(ping({ Headers: headers }));

    expect(client.published[client.published.length - 1].Headers).to.deep.equal(headers);
  });
});
