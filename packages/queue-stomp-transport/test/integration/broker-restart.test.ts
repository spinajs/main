import { expect } from 'chai';
import * as sinon from 'sinon';
import { randomUUID } from 'crypto';
import { BROKER_CONTAINER, requireBroker, sleep, uniqueQueue, waitFor } from './support/env.js';
import { docker, dockerControlAvailable, ensureBrokerUp, waitForBroker } from './support/docker.js';
import { client, disposeClients, useConfig } from './support/client.js';
import { jobIdOf, jobMessage } from './support/messages.js';

async function restartBroker(): Promise<void> {
  await docker('restart', '--time', '20', BROKER_CONTAINER);
  await waitForBroker();
}

describe('ActiveMQ integration - broker restart', function () {
  this.timeout(180000);

  before(async function () {
    await requireBroker(this);
    if (!(await dockerControlAvailable())) {
      this.skip();
    }
  });

  beforeEach(async () => {
    await useConfig();
  });

  afterEach(async () => {
    await disposeClients();
    await ensureBrokerUp();
  });

  it('reconnects and replays its subscriptions after a broker restart', async () => {
    const channel = uniqueQueue('restart');
    const c = await client({ defaultQueueChannel: channel, reconnectDelay: 1000 });
    const got = sinon.stub().resolves();
    await c.subscribe(channel, got);

    await restartBroker();
    await waitFor(() => c.Connected, 60000, 'client reconnected');
    await c.emit(jobMessage());

    await waitFor(() => got.calledOnce, 10000, 'delivery after reconnect');
  });

  it('keeps a persistent job across a broker restart', async () => {
    const channel = uniqueQueue('persist');
    const producer = await client({ defaultQueueChannel: channel });
    const sent = jobMessage();
    await producer.emit(sent);
    await producer.dispose();

    await restartBroker();

    const consumer = await client({ defaultQueueChannel: channel });
    const got: string[] = [];
    await consumer.subscribe(channel, async (m) => {
      got.push(jobIdOf(m));
    });
    await waitFor(() => got.length === 1, 15000, 'persisted job delivered');
    expect(got).to.deep.eq([jobIdOf(sent)]);
  });

  it('fires a scheduled job after a broker restart', async () => {
    const channel = uniqueQueue('scheduled');
    const producer = await client({ defaultQueueChannel: channel });
    const sentAt = Date.now();
    await producer.emit(jobMessage({ ScheduleDelay: 20000 }));
    await producer.dispose();

    await restartBroker();

    const consumer = await client({ defaultQueueChannel: channel });
    const deliveredAt: number[] = [];
    await consumer.subscribe(channel, async () => {
      deliveredAt.push(Date.now());
    });
    await waitFor(() => deliveredAt.length === 1, 90000, 'scheduled job delivered after restart');
    expect(deliveredAt[0] - sentAt).to.be.at.least(19500);
  });

  it('holds an emit issued while the broker is down and publishes it once the broker is back', async () => {
    const channel = uniqueQueue('outage');
    const c = await client({ defaultQueueChannel: channel, reconnectDelay: 1000 });

    await docker('stop', '--time', '20', BROKER_CONTAINER);
    await waitFor(() => !c.Connected, 30000, 'client noticed the outage');

    let settled = false;
    const emitted = c.emit(jobMessage()).then(() => {
      settled = true;
    });
    await sleep(2000);
    expect(settled, 'emit must wait for the broker').to.be.false;

    await docker('start', BROKER_CONTAINER);
    await waitForBroker();
    await emitted;

    const got = sinon.stub().resolves();
    await c.subscribe(channel, got);
    await waitFor(() => got.calledOnce, 15000, 'held emit delivered');
  });

  it('loses no emit across a broker restart', async () => {
    const channel = uniqueQueue('storm');
    const c = await client({ defaultQueueChannel: channel, reconnectDelay: 1000, receiptTimeout: 2000 });
    const ids: string[] = [];
    const outcomes: Array<Promise<unknown>> = [];
    const restart = sleep(1000).then(() => docker('restart', '--time', '20', BROKER_CONTAINER));

    for (let i = 0; i < 40; i++) {
      const id = randomUUID();
      ids.push(id);
      outcomes.push(
        c.emit(jobMessage({ JobId: id })).then(
          () => 'sent',
          (err) => err,
        ),
      );
      await sleep(100);
    }
    await restart;
    await waitForBroker();

    const results = await Promise.all(outcomes);
    expect(results.filter((r) => r !== 'sent'), 'every emit eventually confirmed').to.have.length(0);

    const got = new Set<string>();
    await c.subscribe(channel, async (m) => {
      got.add(jobIdOf(m));
    });
    await waitFor(() => ids.every((id) => got.has(id)), 60000, 'all 40 jobs delivered');
  });
});
