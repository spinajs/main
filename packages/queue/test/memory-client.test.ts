import { DI } from '@spinajs/di';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import { IQueueMessage, QueueMessageType } from '../src/index.js';
import { MemoryBroker, MemoryQueueClient } from '../src/testing/index.js';
import { bootClient, brokerName, OTHER_TOPIC } from './support/memory-harness.js';

const expect = chai.expect;

function message(type: QueueMessageType, extra: Partial<IQueueMessage> = {}): IQueueMessage {
  return { Name: 'MemoryPing', Type: type, CreatedAt: DateTime.now(), Persistent: false, Priority: 0, ...extra };
}

describe('MemoryQueueClient', function () {
  this.timeout(15000);

  afterEach(async () => {
    await DI.dispose();
    DI.clearCache();
  });

  describe('default mode', () => {
    it('fans an event out to every client of the broker during emit()', async () => {
      const broker = brokerName('fanout');
      const a = new MemoryQueueClient({ name: 'a', options: { broker } } as never);
      const b = new MemoryQueueClient({ name: 'b', options: { broker } } as never);
      await a.resolve();
      await b.resolve();
      const heard: string[] = [];
      await a.subscribe('/topic/x', async (e) => void heard.push(`a:${e.Name}`));
      await b.subscribe('/topic/x', async (e) => void heard.push(`b:${e.Name}`));

      await a.emit(message(QueueMessageType.Event));

      expect(heard).to.deep.equal(['a:MemoryPing', 'b:MemoryPing']);
      expect(a.Emitted).to.have.length(1);
      expect(a.published).to.equal(a.Emitted);
      MemoryBroker.drop(broker);
    });

    it('records a job without delivering it until deliver() is called', async () => {
      const client = new MemoryQueueClient({ name: 'jobs', options: { broker: brokerName('jobs') } } as never);
      await client.resolve();
      const heard: IQueueMessage[] = [];
      await client.subscribe('/queue/x', async (e) => void heard.push(e));

      await client.emit(message(QueueMessageType.Job));
      expect(heard).to.have.length(0);

      await client.deliver(client.Emitted[0]);
      expect(heard).to.have.length(1);
    });
  });

  describe('deferred mode', () => {
    it('only queues on emit() and delivers in publish order on deliverAll()', async () => {
      const client = await bootClient({ broker: brokerName('order'), deferred: true });
      const heard: string[] = [];
      await client.subscribe('/queue/memory', async (e) => void heard.push(e.MessageId!));

      await client.emit(message(QueueMessageType.Job, { MessageId: 'm-1' }));
      await client.emit(message(QueueMessageType.Job, { MessageId: 'm-2' }));
      expect(heard).to.deep.equal([]);
      expect(client.published.map((m) => m.MessageId)).to.deep.equal(['m-1', 'm-2']);

      await client.deliverAll();
      expect(heard).to.deep.equal(['m-1', 'm-2']);

      await client.deliverAll();
      expect(heard, 'a settled message is not delivered again').to.deep.equal(['m-1', 'm-2']);
    });

    it('delivers a message whose callback rejected again on the next deliverAll()', async () => {
      const client = await bootClient({ broker: brokerName('retry'), deferred: true });
      let calls = 0;
      await client.subscribe('/queue/memory', async () => {
        if (++calls === 1) throw new Error('first attempt fails');
      });

      await client.emit(message(QueueMessageType.Job, { MessageId: 'm-1' }));
      await client.deliverAll();
      expect(calls).to.equal(1);

      await client.deliverAll();
      expect(calls).to.equal(2);

      await client.deliverAll();
      expect(calls).to.equal(2);
      expect(client.published).to.have.length(1);
    });

    it('re-queues a rejected job without an owner, so a consumer that subscribes later gets it', async () => {
      const client = await bootClient({ broker: brokerName('job-owner'), deferred: true });
      await client.subscribe('/queue/memory', () => Promise.reject(new Error('first consumer fails')));
      await client.emit(message(QueueMessageType.Job, { MessageId: 'm-1' }));
      await client.deliverAll();

      client.unsubscribe();
      const heard: string[] = [];
      await client.subscribe('/queue/memory', async (e) => void heard.push(e.MessageId!));
      await client.deliverAll();
      expect(heard).to.deep.equal(['m-1']);
    });

    it('settles a message only after its callback resolved', async () => {
      const client = await bootClient({ broker: brokerName('settle'), deferred: true });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let calls = 0;
      await client.subscribe('/queue/memory', async () => {
        calls++;
        await gate;
      });

      await client.emit(message(QueueMessageType.Job));
      const first = client.deliverAll();
      await client.deliverAll();
      expect(calls, 'an unsettled message is not handed out twice').to.equal(1);

      release();
      await first;
      await client.deliverAll();
      expect(calls).to.equal(1);
    });

    it('keeps a job for a channel without a consumer until one subscribes', async () => {
      const client = await bootClient({ broker: brokerName('late'), deferred: true });
      await client.emit(message(QueueMessageType.Job));
      await client.deliverAll();

      const heard: IQueueMessage[] = [];
      await client.subscribe('/queue/memory', async (e) => void heard.push(e));
      await client.deliverAll();
      expect(heard).to.have.length(1);
    });

    it('fans an event out to every subscription on its channel', async () => {
      const client = await bootClient({ broker: brokerName('event-fanout'), deferred: true });
      const heard: string[] = [];
      await client.subscribe('/topic/memory', async () => void heard.push('a'));
      await client.subscribe('/topic/memory', async () => void heard.push('b'));

      await client.emit(message(QueueMessageType.Event));
      await client.deliverAll();
      expect(heard).to.deep.equal(['a', 'b']);
    });

    it('retries a rejected event only to the subscription that failed', async () => {
      const client = await bootClient({ broker: brokerName('event-retry'), deferred: true });
      const heard: string[] = [];
      let failures = 1;
      await client.subscribe('/topic/memory', async () => void heard.push('ok'));
      await client.subscribe('/topic/memory', async () => {
        heard.push('flaky');
        if (failures-- > 0) throw new Error('fails once');
      });

      await client.emit(message(QueueMessageType.Event));
      await client.deliverAll();
      await client.deliverAll();
      expect(heard).to.deep.equal(['ok', 'flaky', 'flaky']);
    });

    it('drops an event nobody subscribed to', async () => {
      const client = await bootClient({ broker: brokerName('event-drop'), deferred: true });
      await client.emit(message(QueueMessageType.Event));
      await client.deliverAll();

      const heard: IQueueMessage[] = [];
      await client.subscribe('/topic/memory', async (e) => void heard.push(e));
      await client.deliverAll();
      expect(heard).to.have.length(0);
    });

    it('delivers by channel', async () => {
      const client = await bootClient({ broker: brokerName('channels'), deferred: true });
      const heard: string[] = [];
      await client.subscribe('/topic/memory', async (e) => void heard.push(`memory:${e.Name}`));
      await client.subscribe(OTHER_TOPIC, async (e) => void heard.push(`other:${e.Name}`));

      await client.emit(message(QueueMessageType.Event));
      await client.emit(message(QueueMessageType.Event, { Name: 'MemoryOther' }));
      await client.deliverAll();
      expect(heard).to.deep.equal(['memory:MemoryPing', 'other:MemoryOther']);
    });

    it('adds x-spinajs-message-id to the Headers it delivers', async () => {
      const client = await bootClient({ broker: brokerName('headers'), deferred: true });
      const heard: IQueueMessage[] = [];
      await client.subscribe('/topic/memory', async (e) => void heard.push(e));

      await client.emit(message(QueueMessageType.Event, { MessageId: 'm-1', Headers: { 'x-app': 'a' } }));
      await client.deliverAll();
      expect(heard[0].Headers).to.deep.equal({ 'x-app': 'a', 'x-spinajs-message-id': 'm-1' });
      expect(client.published[0].Headers, 'published keeps what the client accepted').to.deep.equal({ 'x-app': 'a' });
    });
  });
});
