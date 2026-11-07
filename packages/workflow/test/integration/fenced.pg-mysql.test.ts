import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { FaultInjector, RowLease } from '@spinajs/durable';
import { QueryContext, type OrmDriver } from '@spinajs/orm';
import { InstanceStore, LeaseLostError, Workflow, WorkflowDefinition, WorkflowInstanceModel, WorkflowService, workflowDriver, type WorkflowContext } from '../../src/index.js';
import { engine } from '../support/engine.js';
import { disposeTestEnv } from '../support/env.js';
import { TestCrash, TestFaults } from '../support/faults.js';
import { instance, pick, rejects, seedEvent, seedInstance, stepsOf, T0 } from '../support/rows.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

let commits = 0;
const executions = new Map<string, number>();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type RawDriver = OrmDriver & { executeOnDb(stmt: string, params: unknown[], context: QueryContext): Promise<unknown> };

/** Raw on purpose: the scratch table needs a DEFERRABLE unique constraint, which the schema builder cannot declare. */
async function sql(stmt: string, context = QueryContext.Schema): Promise<unknown> {
  return ((await workflowDriver()) as RawDriver).executeOnDb(stmt, [], context);
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

@Workflow('it-count')
export class ItCount extends WorkflowDefinition<null, string> {
  public run(ctx: WorkflowContext<null>): Promise<string> {
    return ctx.step('work', async () => {
      executions.set(ctx.instanceId, (executions.get(ctx.instanceId) ?? 0) + 1);
      await pause(20);
      return 'ok';
    });
  }
}

/** Runs one step named after its input; 'slow' takes a while. */
@Workflow('it-named')
export class ItNamed extends WorkflowDefinition<string, string> {
  public run(ctx: WorkflowContext<string>): Promise<string> {
    return ctx.step(ctx.input, async () => {
      if (ctx.input === 'slow') await pause(200);
      return ctx.input;
    });
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

let retried = 0;

/** Attempt 1 fails; attempt 2's COMMIT fails on the deferred constraint; the next activation's attempt 2 commits. */
@Workflow('it-retry-commit', { retry: { attempts: 2, backoff: 'fixed', delay: '10s' } })
export class ItRetryCommit extends WorkflowDefinition<null, number> {
  public run(ctx: WorkflowContext<null>): Promise<number> {
    return ctx.step(
      'book',
      async ({ attempt }) => {
        retried++;
        if (attempt === 1) throw new Error('transient');
        await sql('INSERT INTO w04_deferred (v) VALUES (1)', QueryContext.Insert);
        if (retried === 2) await sql('INSERT INTO w04_deferred (v) VALUES (1)', QueryContext.Insert);
        return retried;
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

    it('three replicas with concurrency 4 ticking at once run every instance exactly once', async () => {
      await bootRealDb(target, { workflow: { concurrency: 4 } });
      executions.clear();
      const service = await DI.resolve(WorkflowService);
      const ids = Array.from({ length: 24 }, (_, i) => `c${i}`);
      for (const id of ids) await service.start('it-count', null, { id });
      const replicas = [await engine('r1'), await engine('r2'), await engine('r3')];
      for (let round = 0; round < 12; round++) await Promise.all(replicas.map((r) => r.tick()));
      expect(ids.map((id) => executions.get(id))).to.deep.equal(ids.map(() => 1));
      for (const id of ids) expect((await instance(id)).Status).to.equal('completed');
    });

    it("a crash in one activation stops every other activation's writes and rejects the tick", async () => {
      TestFaults.reset();
      await bootRealDb(target, { workflow: { concurrency: 2 }, register: () => DI.register(TestFaults).as(FaultInjector) });
      TestFaults.crashOnce('workflow.after-step-fn', 'step:boom');
      const service = await DI.resolve(WorkflowService);
      await service.start('it-named', 'slow', { id: 'slow' });
      await service.start('it-named', 'boom', { id: 'boom' });
      // claimed after 'slow', which is then already running when 'boom' crashes
      await WorkflowInstanceModel.update({ UpdatedAt: T0 + 1 }).where('Id', 'boom');
      expect(await rejects((await engine()).tick())).to.be.instanceOf(TestCrash);
      for (const id of ['slow', 'boom']) {
        expect(pick(await instance(id), 'Status', 'ClaimedBy')).to.deep.equal({ Status: 'running', ClaimedBy: 'r1' });
        expect((await stepsOf(id)).length).to.equal(0);
      }
      TestFaults.reset();
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

    (target.name === 'postgres' ? it : it.skip)('a COMMIT failure of a retried transactional attempt spends no retry and stores no error', async () => {
      const { clock } = await bootRealDb(target);
      retried = 0;
      await sql('DROP TABLE IF EXISTS w04_deferred');
      await sql('CREATE TABLE w04_deferred (v int, CONSTRAINT w04_deferred_v UNIQUE (v) DEFERRABLE INITIALLY DEFERRED)');
      try {
        const { id } = await (await DI.resolve(WorkflowService)).start('it-retry-commit', null);
        const r1 = await engine();
        await r1.tick();
        clock.set(T0 + 10_000);
        await r1.tick();
        expect(pick(await instance(id), 'Status', 'Error', 'WakeAt', 'ClaimedBy')).to.deep.equal({ Status: 'running', Error: null, WakeAt: T0 + 10_000, ClaimedBy: null });
        const [row] = await stepsOf(id);
        expect([row.Status, row.Attempt, row.Error?.message, await sql('SELECT v FROM w04_deferred', QueryContext.Select)]).to.deep.equal(['retrying', 1, 'transient', []]);
        await r1.tick();
        expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 3 });
        expect(pick((await stepsOf(id))[0], 'Status', 'Attempt')).to.deep.equal({ Status: 'succeeded', Attempt: 2 });
      } finally {
        await sql('DROP TABLE IF EXISTS w04_deferred');
      }
    });
  });
}
