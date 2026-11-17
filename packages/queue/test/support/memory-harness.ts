import { Configuration, FrameworkConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import { Clock } from '@spinajs/durable';
import { FakeClock } from '@spinajs/durable/testing';
import { QueueService } from '../../src/index.js';
import { conformanceRouting, MemoryBroker, MemoryQueueClient } from '../../src/testing/index.js';
import type { TransportHarness } from '../../src/testing/index.js';

let seq = 0;

/** Where `MemoryOther` is routed, so a case can publish on two channels. */
export const OTHER_TOPIC = '/topic/other';

/** An event whose failed handler is retried at once, into the failing subscription only. */
export const RETRIED_EVENT = 'MemoryRetried';

function memoryConf(connection: Record<string, unknown>) {
  return class MemoryConf extends FrameworkConfiguration {
    protected onLoad() {
      return {
        logger: {
          targets: [{ name: 'Empty', type: 'BlackHoleTarget', layout: '{message}' }],
          rules: [{ name: '*', level: 'error', target: 'Empty' }],
        },
        queue: {
          default: 'memory',
          routing: { ...conformanceRouting(), MemoryOther: OTHER_TOPIC, [RETRIED_EVENT]: { maxRetries: 1, onEventFailure: 'retry' } },
          connections: [connection],
        },
      };
    }
  };
}

export function brokerName(prefix: string): string {
  return `${prefix}-${++seq}`;
}

export async function bootClientWithClock(options: { broker: string; deferred?: boolean }): Promise<{ client: MemoryQueueClient; clock: FakeClock }> {
  DI.clearCache();
  const clock = new FakeClock(0);
  DI.register(() => clock).as(Clock);
  DI.register(memoryConf({ service: 'MemoryQueueClient', name: 'memory', defaultQueueChannel: '/queue/memory', defaultTopicChannel: '/topic/memory', defaultQueueDeadLetterChannel: '/queue/memory.dlq', options })).as(Configuration);
  await DI.resolve(Configuration);
  const queue = await DI.resolve(QueueService);
  const client = queue.get('memory');
  if (!(client instanceof MemoryQueueClient)) throw new Error('the memory connection is not a MemoryQueueClient');
  return { client, clock };
}

export async function bootClient(options: { broker: string; deferred?: boolean }): Promise<MemoryQueueClient> {
  return (await bootClientWithClock(options)).client;
}

export async function memoryHarness(): Promise<TransportHarness> {
  const broker = brokerName('conformance');
  const { client, clock } = await bootClientWithClock({ broker, deferred: true });
  return {
    client,
    deliverAll: () => client.deliverAll(),
    advance: (ms) => clock.advance(ms),
    // an unsettled delivery stays in the broker, so the next deliverAll() hands it out again
    redeliverUnsettled: () => Promise.resolve(),
    deadLetters: (channel) => Promise.resolve(client.deadLettered.filter((d) => d.channel === channel).map(({ message, headers }) => ({ message, headers }))),
    dispose: async () => {
      await DI.dispose();
      DI.clearCache();
      MemoryBroker.drop(broker);
    },
  };
}
