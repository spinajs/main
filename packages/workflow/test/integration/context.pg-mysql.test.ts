import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { FaultInjector } from '@spinajs/durable';
import { WorkflowAborted, workflowDriver } from '../../src/index.js';
import { activation } from '../support/activation.js';
import { disposeTestEnv } from '../support/env.js';
import { TestFaults } from '../support/faults.js';
import { eventsOf, instance, pick, rejects, seedEvent, seedInstance, stepsOf, takeOver } from '../support/rows.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`ActivationContext (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(async () => {
      TestFaults.reset();
      await bootRealDb(target, { register: () => DI.register(TestFaults).as(FaultInjector) });
      await seedInstance('c1');
    });
    after(disposeTestEnv);

    it('journals a step, then replays it without running it again', async () => {
      const first = await activation('c1');
      expect(await first.ctx.step('charge', () => ({ total: 42 }))).to.deep.equal({ total: 42 });
      await first.release();
      const second = await activation('c1');
      let calls = 0;
      const replayed = await second.ctx.step('charge', () => ++calls);
      await second.release();
      expect([replayed, calls, (await stepsOf('c1')).length, (await instance('c1')).ClaimedBy]).to.deep.equal([{ total: 42 }, 0, 1, null]);
    });

    it('after a takeover the journal write is lease-lost and writes no row', async () => {
      const h = await activation('c1');
      await takeOver('c1');
      expect(((await rejects(h.ctx.step('book', () => 'ok'))) as WorkflowAborted).reason).to.equal('lease-lost');
      expect((await stepsOf('c1')).length).to.equal(0);
      expect(pick(await instance('c1'), 'ClaimedBy', 'ClaimEpoch')).to.deep.equal({ ClaimedBy: 'other', ClaimEpoch: 99 });
    });

    it("a takeover during a transactional step rolls back the body's write and the journal row", async () => {
      const h = await activation('c1');
      // The takeover commits on another connection while the step's transaction is open.
      const driver = (await workflowDriver()) as unknown as { TransactionStorage: { exit<R>(f: () => R): R } };
      const book = async () => {
        await seedEvent('side', 'booked');
        await driver.TransactionStorage.exit(() => takeOver('c1'));
        return 'ok';
      };
      expect(((await rejects(h.ctx.step('book', book, { transactional: true }))) as WorkflowAborted).reason).to.equal('lease-lost');
      expect([(await eventsOf('side')).length, (await stepsOf('c1')).length]).to.deep.equal([0, 0]);
    });
  });
}
