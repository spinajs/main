import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import * as chai from 'chai';
import { DateTime } from 'luxon';
import { IQueueMessage, QueueMessageType, QueueService } from '../src/index.js';
import { describeQueueTransportConformance, MemoryBroker, MemoryQueueClient } from '../src/testing/index.js';
import type { TransportHarness } from '../src/testing/index.js';

const expect = chai.expect;

let seq = 0;

function memoryConf(connection: Record<string, unknown>) {
  return class MemoryConf extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
          rules: [{ name: '*', level: 'error', target: 'Empty' }],
        },
        queue: { default: 'memory', routing: {}, connections: [connection] },
      };
    }
  };
}

async function bootClient(options: { broker: string; deferred?: boolean }): Promise<MemoryQueueClient> {
  DI.clearCache();
  DI.register(memoryConf({ service: 'MemoryQueueClient', name: 'memory', defaultQueueChannel: '/queue/memory', defaultTopicChannel: '/topic/memory', defaultQueueDeadLetterChannel: '/queue/memory.dlq', options })).as(Configuration);
  await DI.resolve(Configuration);
  const queue = await DI.resolve(QueueService);
  return queue.get('memory') as MemoryQueueClient;
}

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
      const broker = `fanout-${++seq}`;
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
      const client = new MemoryQueueClient({ name: 'jobs', options: { broker: `jobs-${++seq}` } } as never);
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
      const client = await bootClient({ broker: `order-${++seq}`, deferred: true });
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
      const client = await bootClient({ broker: `retry-${++seq}`, deferred: true });
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

    it('settles a message only after its callback resolved', async () => {
      const client = await bootClient({ broker: `settle-${++seq}`, deferred: true });
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
      const client = await bootClient({ broker: `late-${++seq}`, deferred: true });
      await client.emit(message(QueueMessageType.Job));
      await client.deliverAll();

      const heard: IQueueMessage[] = [];
      await client.subscribe('/queue/memory', async (e) => void heard.push(e));
      await client.deliverAll();
      expect(heard).to.have.length(1);
    });
  });
});

describeQueueTransportConformance('MemoryQueueClient', async (): Promise<TransportHarness> => {
  const broker = `conformance-${++seq}`;
  const client = await bootClient({ broker, deferred: true });
  return {
    client,
    deliverAll: () => client.deliverAll(),
    advance: () => Promise.resolve(),
    deadLetters: (channel) => Promise.resolve(client.deadLettered.filter((d) => d.channel === channel).map(({ message, headers }) => ({ message, headers }))),
    dispose: async () => {
      await DI.dispose();
      DI.clearCache();
      MemoryBroker.drop(broker);
    },
  };
});
