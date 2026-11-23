import 'mocha';
import { readQueueHeaders, type IQueueMessage } from '@spinajs/queue';
import { CONFORMANCE_MAX_DELAY_MS, conformanceRouting, deadLetterBody, describeQueueTransportConformance, type TransportHarness } from '@spinajs/queue/testing';
import { StompQueueClient } from '../../src/connection.js';
import { client, disposeClients, useConfig } from './support/client.js';
import { requireBroker, retryConnect, sleep, STOMP_LOGIN, STOMP_PASSWORD, STOMP_URL, uniqueQueue } from './support/env.js';

const QUIET_MS = 750;
let sequence = 0;

class RawStompClient extends StompQueueClient {
  public get raw() {
    return this.Client;
  }
}

async function stompHarness(): Promise<TransportHarness> {
  const queue = uniqueQueue('conf');
  const topic = `/topic/VirtualTopic.conf.${Date.now()}.${++sequence}`;
  const dlq = `${queue}.dlq`;

  await useConfig({ queue: { routing: conformanceRouting() } });
  const transport = await client({ defaultQueueChannel: queue, defaultTopicChannel: topic, defaultQueueDeadLetterChannel: dlq, options: { virtualTopics: true } });
  const reader = await retryConnect(async () => {
    const r = new RawStompClient({ service: 'StompQueueClient', name: `conf-reader-${Date.now()}-${sequence}`, host: STOMP_URL, login: STOMP_LOGIN, password: STOMP_PASSWORD });
    await r.resolve();
    return r;
  });

  return {
    client: transport,
    deliverAll: () => sleep(QUIET_MS),
    advance: (ms) => sleep(Math.min(ms, CONFORMANCE_MAX_DELAY_MS + 500)),
    async deadLetters(channel) {
      const found: { message: IQueueMessage; headers: Record<string, string> }[] = [];
      const subscription = reader.raw.subscribe(
        channel,
        (frame) => {
          found.push({ message: deadLetterBody(frame.body), headers: readQueueHeaders(frame.headers) });
          frame.ack();
        },
        { ack: 'client-individual' },
      );
      await sleep(QUIET_MS);
      subscription.unsubscribe();
      return found;
    },
    async injectRaw(channel, body) {
      reader.raw.publish({ destination: channel, body, headers: { persistent: 'true' } });
      await sleep(100);
    },
    async dispose() {
      await reader.dispose();
      await disposeClients();
    },
  };
}

describe('ActiveMQ integration - delivery conformance', function () {
  before(async function () {
    await requireBroker(this);
  });

  // the crash case needs a dropped connection to hand the unsettled frame out again; the unit file covers the transport's side
  describeQueueTransportConformance('stomp (activemq)', stompHarness);
});
