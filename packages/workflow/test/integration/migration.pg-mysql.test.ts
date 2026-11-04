import { expect } from 'chai';
import { disposeTestEnv } from '../support/env.js';
import { eventsOf, instance, pick, rejects, seedEvent, seedInstance, seedStep, stepsOf } from '../support/rows.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

const FAR = Date.parse('2200-01-01T00:00:00.000Z');

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`workflow migration (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(() => bootRealDb(target));
    after(disposeTestEnv);

    it('round-trips BIGINT times, LONGTEXT JSON and boolean flags', async () => {
      await seedInstance('i1', { Input: { order: 7 }, WakeAt: FAR, CreatedAt: FAR, UpdatedAt: FAR, CancelRequested: true });
      const row = await instance('i1');
      expect(pick(row, 'Input', 'WakeAt', 'CreatedAt', 'CancelRequested', 'ClaimEpoch')).to.deep.equal({ Input: { order: 7 }, WakeAt: FAR, CreatedAt: FAR, CancelRequested: true, ClaimEpoch: 0 });
      await seedStep('i1', 1, 'sleep:nap#1', { Status: 'pending', Meta: { wakeAt: FAR } });
      expect((await stepsOf('i1'))[0].Meta).to.deep.equal({ wakeAt: FAR });
    });

    it('enforces (InstanceId, Key) and (InstanceId, DedupKey), and allows many events without a key', async () => {
      await seedStep('i1', 1, 'step:a#1');
      expect(await rejects(seedStep('i1', 2, 'step:a#1'))).to.be.instanceOf(Error);
      await seedEvent('i1', 'go', { DedupKey: 'k' });
      expect(await rejects(seedEvent('i1', 'go', { DedupKey: 'k' }))).to.be.instanceOf(Error);
      await seedEvent('i1', 'go');
      await seedEvent('i1', 'go');
      expect((await eventsOf('i1')).length).to.equal(3);
    });
  });
}
