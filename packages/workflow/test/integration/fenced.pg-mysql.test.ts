import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { RowLease } from '@spinajs/durable';
import { QueryContext } from '@spinajs/orm';
import { InstanceStore, LeaseLostError, Workflow, WorkflowDefinition, WorkflowService, workflowDriver, type WorkflowContext } from '../../src/index.js';
import { engine } from '../support/engine.js';
import { disposeTestEnv } from '../support/env.js';
import { instance, pick, rejects, seedEvent, seedInstance, stepsOf, T0 } from '../support/rows.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

let commits = 0;

async function sql(stmt: string, context = QueryContext.Schema): Promise<unknown> {
  return (await workflowDriver()).executeOnDb(stmt, [], context);
}

@Workflow('it-sum')
export class ItSum extends WorkflowDefinition<{ a: number; b: number }, number> {
  public run(ctx: WorkflowContext<{ a: number; b: number }>): Promise<number> {
    return ctx.step('add', () => ctx.input.a + ctx.input.b);
  }
}

@Workflow('it-noop')
export class ItNoop extends WorkflowDefinition<null, string> {
  public run(): Promise<string> {
    return Promise.resolve('woke');
  }
}

/** The first attempt breaks a deferred unique constraint, which Postgres checks only at COMMIT. */
@Workflow('it-commit')
export class ItCommit extends WorkflowDefinition<null, number> {
  public run(ctx: WorkflowContext<null>): Promise<number> {
    return ctx.step(
      'book',
      async () => {
        commits++;
        await sql('INSERT INTO w04_deferred (v) VALUES (1)', QueryContext.Insert);
        if (commits === 1) await sql('INSERT INTO w04_deferred (v) VALUES (1)', QueryContext.Insert);
        return commits;
      },
      { transactional: true },
    );
  }
}

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`workflow fenced writes (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(() => bootRealDb(target));
    after(disposeTestEnv);

    it('a fenced step write commits for the owner and is refused for a stale epoch', async () => {
      await seedInstance('f1');
      const driver = await workflowDriver();
      const a = new InstanceStore(driver, new RowLease(driver), 'a');
      const b = new InstanceStore(driver, new RowLease(driver), 'b');
      const first = (await a.lease.claim(a.target('f1'), 'a', 1000, T0))!;
      const row = { instanceId: 'f1', seq: 1, kind: 'step' as const, status: 'succeeded' as const, attempt: 1, startedAt: T0, finishedAt: T0 };
      await a.fenced('f1', first.epoch, T0, () => a.saveStep(undefined, { ...row, key: 'step:a#1', result: { value: 1 } }));
      const second = (await b.lease.claim(b.target('f1'), 'b', 1000, T0 + 2000))!;
      expect(second.epoch).to.equal(first.epoch + 1);
      expect(await rejects(a.fenced('f1', first.epoch, T0 + 2000, () => a.saveStep(undefined, { ...row, seq: 2, key: 'step:b#1' })))).to.be.instanceOf(LeaseLostError);
      expect((await stepsOf('f1')).map((s) => [s.Key, s.Result])).to.deep.equal([['step:a#1', 1]]);
    });

    it('runs a whole activation: BIGINT times, JSON result, released lease', async () => {
      const { id } = await (await DI.resolve(WorkflowService)).start('it-sum', { a: 20, b: 22 });
      await (await engine()).tick();
      expect(pick(await instance(id), 'Status', 'Result', 'ClaimedBy', 'FinishedAt')).to.deep.equal({ Status: 'completed', Result: 42, ClaimedBy: null, FinishedAt: T0 });
    });

    it('activates at most workflow.concurrency instances per tick', async () => {
      await bootRealDb(target, { workflow: { concurrency: 2 } });
      const service = await DI.resolve(WorkflowService);
      for (const id of ['n1', 'n2', 'n3']) await service.start('it-noop', null, { id });
      await (await engine()).tick();
      const statuses = await Promise.all(['n1', 'n2', 'n3'].map(async (id) => (await instance(id)).Status));
      expect(statuses.filter((s) => s === 'completed').length).to.equal(2);
    });

    it('finds a waiting instance whose signal landed while it was parked (quoted raw join)', async () => {
      await seedInstance('w1', { Workflow: 'it-noop', Status: 'waiting', WaitingFor: 'go' });
      await seedEvent('w1', 'go');
      await (await engine()).tick();
      expect((await instance('w1')).Status).to.equal('completed');
    });

    (target.name === 'postgres' ? it : it.skip)('a transactional step whose COMMIT fails journals nothing, spends no retry and runs again on the next activation', async () => {
      commits = 0;
      await sql('DROP TABLE IF EXISTS w04_deferred');
      await sql('CREATE TABLE w04_deferred (v int, CONSTRAINT w04_deferred_v UNIQUE (v) DEFERRABLE INITIALLY DEFERRED)');
      try {
        const { id } = await (await DI.resolve(WorkflowService)).start('it-commit', null);
        const r1 = await engine();
        await r1.tick();
        expect(pick(await instance(id), 'Status', 'Error', 'ClaimedBy', 'WakeAt')).to.deep.equal({ Status: 'running', Error: null, ClaimedBy: null, WakeAt: null });
        expect([(await stepsOf(id)).length, await sql('SELECT v FROM w04_deferred', QueryContext.Select)]).to.deep.equal([0, []]);
        await r1.tick();
        expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 2 });
        expect((await stepsOf(id)).map((s) => [s.Key, s.Status, s.Attempt])).to.deep.equal([['step:book#1', 'succeeded', 1]]);
        expect(await sql('SELECT v FROM w04_deferred', QueryContext.Select)).to.deep.equal([{ v: 1 }]);
      } finally {
        await sql('DROP TABLE IF EXISTS w04_deferred');
      }
    });
  });
}
