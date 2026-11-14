import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { QueueService } from '../../src/index.js';
import { MemoryBroker, MemoryQueueClient } from '../../src/testing/index.js';
import type { TransportHarness } from '../../src/testing/index.js';

let seq = 0;

/** Where `MemoryOther` is routed, so a case can publish on two channels. */
export const OTHER_TOPIC = '/topic/other';

function memoryConf(connection: Record<string, unknown>) {
  return class MemoryConf extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
          rules: [{ name: '*', level: 'error', target: 'Empty' }],
        },
        queue: { default: 'memory', routing: { MemoryOther: OTHER_TOPIC }, connections: [connection] },
      };
    }
  };
}

export function brokerName(prefix: string): string {
  return `${prefix}-${++seq}`;
}

export async function bootClient(options: { broker: string; deferred?: boolean }): Promise<MemoryQueueClient> {
  DI.clearCache();
  DI.register(memoryConf({ service: 'MemoryQueueClient', name: 'memory', defaultQueueChannel: '/queue/memory', defaultTopicChannel: '/topic/memory', defaultQueueDeadLetterChannel: '/queue/memory.dlq', options })).as(Configuration);
  await DI.resolve(Configuration);
  const queue = await DI.resolve(QueueService);
  return queue.get('memory') as MemoryQueueClient;
}

export async function memoryHarness(): Promise<TransportHarness> {
  const broker = brokerName('conformance');
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
}
