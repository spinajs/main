import { expect } from 'chai';
import * as sinon from 'sinon';
import { Event, QueueEvent } from '@spinajs/queue';
import { removeTempDir, requireBroker, sleep, uniqueQueue, uniqueTopic, waitFor } from './support/env.js';
import { client, disposeClients, useConfig } from './support/client.js';
import { eventMessage } from './support/messages.js';
import { startApp, stopApp, tempDbFile } from './support/app.js';

@Event()
class ItPingEvent extends QueueEvent {
  public Seq: number;
}

describe('ActiveMQ integration - events', function () {
  this.timeout(60000);

  let db: { dir: string; file: string } | undefined;

  before(async function () {
    await requireBroker(this);
  });

  beforeEach(async () => {
    await useConfig();
  });

  afterEach(async () => {
    await disposeClients();
    await stopApp();
    if (db) {
      removeTempDir(db.dir);
      db = undefined;
    }
  });

  it('fans one event out to every connection subscribed to the topic', async () => {
    const topic = uniqueTopic('fanout');
    const consumers = [await client(), await client(), await client()];
    const received = consumers.map(() => sinon.stub().resolves());
    for (let i = 0; i < consumers.length; i++) {
      await consumers[i].subscribe(topic, received[i]);
    }
    await sleep(500);

    const producer = await client({ defaultTopicChannel: topic });
    await producer.emit(eventMessage());

    await waitFor(() => received.every((s) => s.calledOnce), 10000, 'every consumer got the event');
    await sleep(500);
    expect(received.map((s) => s.callCount)).to.deep.eq([1, 1, 1]);
  });

  it('keeps events for a durable subscriber while it is offline', async () => {
    const topic = uniqueTopic('durable');
    const clientId = `it-durable-${Date.now()}`;
    const subscription = `it-durable-sub-${Date.now()}`;

    const first = await client({ clientId });
    await first.subscribe(topic, sinon.stub().resolves(), subscription, true);
    await sleep(500);
    await first.dispose();

    const producer = await client({ defaultTopicChannel: topic });
    await producer.emit(eventMessage({ Seq: 7 }));

    const second = await client({ clientId });
    const received: number[] = [];
    await second.subscribe(
      topic,
      async (m) => {
        received.push((m as unknown as { Seq: number }).Seq);
      },
      subscription,
      true,
    );

    await waitFor(() => received.length === 1, 10000, 'missed event delivered on reconnect');
    expect(received).to.deep.eq([7]);
    second.unsubscribe(topic, true);
  });

  it('delivers an event to a QueueService consumer and a raw subscriber alike', async () => {
    db = tempDbFile();
    const topic = uniqueTopic('service');
    const queue = await startApp({ dbFile: db.file, jobChannel: uniqueQueue('unused'), topicChannel: topic });
    const raw = await client();
    const rawGot = sinon.stub().resolves();
    await raw.subscribe(topic, rawGot);
    const serviceGot: number[] = [];
    await queue.consume(ItPingEvent, async (e: ItPingEvent) => {
      serviceGot.push(e.Seq);
    });
    await sleep(500);

    await ItPingEvent.emit({ Seq: 1 });

    await waitFor(() => rawGot.calledOnce && serviceGot.length === 1, 10000, 'both subscribers got the event');
    expect(serviceGot).to.deep.eq([1]);
  });
});
