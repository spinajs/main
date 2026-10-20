import { expect } from 'chai';
import { requireBroker, sleep, uniqueQueue, waitFor } from './support/env.js';
import { client, disposeClients, useConfig } from './support/client.js';
import { jobMessage } from './support/messages.js';

describe('ActiveMQ integration - prefetch', function () {
  this.timeout(60000);

  before(async function () {
    await requireBroker(this);
  });

  beforeEach(async () => {
    await useConfig();
  });

  afterEach(async () => {
    await disposeClients();
  });

  for (const prefetch of [1, 3]) {
    it(`never runs more than prefetch=${prefetch} jobs at once on one connection`, async () => {
      const channel = uniqueQueue(`prefetch${prefetch}`);
      const c = await client({ defaultQueueChannel: channel, options: { prefetch } });
      let inFlight = 0;
      let maxInFlight = 0;
      let done = 0;

      await c.subscribe(channel, async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(300);
        inFlight--;
        done++;
      });

      await Promise.all(Array.from({ length: 9 }, () => c.emit(jobMessage())));
      await waitFor(() => done === 9, 20000, 'all 9 jobs handled');

      expect(maxInFlight).to.eq(prefetch);
    });
  }
});
