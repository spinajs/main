import { expect } from 'chai';
import { DI } from '@spinajs/di';
import type { IsolationLevel } from '@spinajs/orm';
import { UniqueViolation } from '@spinajs/orm';
import { defineWorkflow, WorkflowDefinition, WorkflowIdConflict, WorkflowInstanceModel, WorkflowService, WorkflowStartConflict, workflowDriver } from '../../src/index.js';
import { disposeTestEnv } from '../support/env.js';
import { deferred, instance } from '../support/rows.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

class ItStartA extends WorkflowDefinition {
  public run(): Promise<void> {
    return Promise.resolve();
  }
}

class ItStartB extends WorkflowDefinition {
  public run(): Promise<void> {
    return Promise.resolve();
  }
}

defineWorkflow(ItStartA, 'it-start-a');
defineWorkflow(ItStartB, 'it-start-b');

type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

const settle = async <T>(p: Promise<T>): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
};

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`WorkflowService.start (${target.name})`, function () {
    this.timeout(60_000);
    let service: WorkflowService;

    beforeEach(async () => {
      await bootRealDb(target);
      service = await DI.resolve(WorkflowService);
    });
    after(disposeTestEnv);

    /** The caller's transaction takes its snapshot, a competitor commits a start of the same id, then the caller starts it. */
    async function startAfterCompetitor(id: string, isolation?: IsolationLevel) {
      const driver = await workflowDriver();
      const snapshotTaken = deferred();
      const competitorDone = deferred();
      const competitor = (async () => {
        await snapshotTaken.promise;
        const result = await service.start('it-start-a', { who: 'competitor' }, { id });
        competitorDone.resolve();
        return result;
      })();
      const caller = settle(
        driver.transaction(
          async () => {
            await WorkflowInstanceModel.where('Id', 'none').first();
            snapshotTaken.resolve();
            await competitorDone.promise;
            return service.start('it-start-a', { who: 'caller' }, { id });
          },
          isolation ? { isolation } : undefined,
        ),
      );
      return { competitor: await competitor, caller: await caller };
    }

    it('concurrent starts with the same input: one row, one created', async () => {
      const results = await Promise.all([service.start('it-start-a', { n: 1 }, { id: 'same' }), service.start('it-start-a', { n: 1 }, { id: 'same' })]);
      expect(results.map((r) => r.created).sort()).to.deep.equal([false, true]);
      expect((await WorkflowInstanceModel.where('Id', 'same')).length).to.equal(1);
    });

    it("concurrent starts with different inputs: one row with the winner's input, the rest not created", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, n) => service.start('it-start-a', { n }, { id: 'many' })));
      const winners = results.flatMap((r, n) => (r.created ? [n] : []));
      expect(winners.length).to.equal(1);
      const rows = await WorkflowInstanceModel.where('Id', 'many');
      expect(rows.length).to.equal(1);
      expect(rows[0].Input).to.deep.equal({ n: winners[0] });
    });

    it('concurrent starts of another workflow on the same id: one created, the other WorkflowIdConflict', async () => {
      const results = await Promise.all([settle(service.start('it-start-a', null, { id: 'clash' })), settle(service.start('it-start-b', null, { id: 'clash' }))]);
      expect(results.filter((r) => r.ok).length).to.equal(1);
      const failed = results.find((r) => !r.ok);
      expect(failed && !failed.ok && failed.error).to.be.instanceOf(WorkflowIdConflict);
    });

    it("a start in a transaction whose snapshot predates a competitor's committed start is not created", async () => {
      const { competitor, caller } = await startAfterCompetitor('snap');
      expect(competitor.created).to.equal(true);
      expect(caller).to.deep.equal({ ok: true, value: { id: 'snap', created: false } });
      expect((await instance('snap')).Input).to.deep.equal({ who: 'competitor' });
    });

    it('at REPEATABLE READ it is not created or fails with WorkflowStartConflict, never a UniqueViolation', async () => {
      const { competitor, caller } = await startAfterCompetitor('snap-rr', 'REPEATABLE READ');
      expect(competitor.created).to.equal(true);
      if (caller.ok) {
        expect(caller.value).to.deep.equal({ id: 'snap-rr', created: false });
      } else {
        expect(caller.error).to.be.instanceOf(WorkflowStartConflict).and.not.instanceOf(UniqueViolation);
      }
      if (target.name === 'mysql') expect(caller.ok).to.equal(true);
      expect((await WorkflowInstanceModel.where('Id', 'snap-rr')).length).to.equal(1);
    });
  });
}
