import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { NonRetryableError } from '@spinajs/durable';
import { Workflow, WorkflowDefinition, WorkflowService, type WorkflowContext } from '../../src/index.js';
import { engine } from '../support/engine.js';
import { disposeTestEnv } from '../support/env.js';
import { eventsOf, instance, pick, seedEvent, seedInstance, seedStep, stepsOf, T0 } from '../support/rows.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

@Workflow('it-svc')
export class ItSvc extends WorkflowDefinition<null, string> {
  public run(): Promise<string> {
    return Promise.resolve('ok');
  }
}

@Workflow('it-wait')
export class ItWait extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    return (await ctx.waitForEvent('go'))?.payload;
  }
}

@Workflow('it-race')
export class ItRace extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    return (await Promise.race([ctx.waitForEvent('approve'), ctx.waitForEvent('reject')]))?.name;
  }
}

@Workflow('it-near')
export class ItNear extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    return (await Promise.race([ctx.waitForEvent('a$'), ctx.waitForEvent('ab')]))?.name;
  }
}

const bank = { down: true };

@Workflow('it-saga')
export class ItSaga extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    await ctx.step('charge', () => 'ch-1', {
      retry: { attempts: 2, backoff: 'fixed', delay: '5s' },
      compensate: () => (bank.down ? Promise.reject(new Error('bank down')) : Promise.resolve()),
    });
    await ctx.step('ship', () => Promise.reject(new NonRetryableError('no courier')));
    return 'shipped';
  }
}

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`workflow service (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(() => bootRealDb(target));
    after(disposeTestEnv);

    it('health() groups unfinished instances by version with quoted raw SQL', async () => {
      await seedInstance('m1', { Workflow: 'it-gone', Version: 3 });
      await seedInstance('m2', { Workflow: 'it-gone', Version: 3, Status: 'sleeping' });
      await seedInstance('m3', { Workflow: 'it-gone', Version: 3, Status: 'failed' });
      expect(await (await DI.resolve(WorkflowService)).health()).to.deep.equal({ missingVersions: [{ workflow: 'it-gone', version: 3, instances: 2 }] });
    });

    it('cancel() and list() on the real database', async () => {
      const service = await DI.resolve(WorkflowService);
      await service.start('it-svc', null, { id: 'b' });
      await service.start('it-svc', null, { id: 'a' });
      await service.cancel('b', 'stop');
      expect(pick(await instance('b'), 'CancelRequested', 'WakeAt', 'Reason')).to.deep.equal({ CancelRequested: true, WakeAt: T0, Reason: 'stop' });
      expect((await service.list({ workflow: 'it-svc' })).map((v) => v.id)).to.deep.equal(['a', 'b']);
    });

    it('signal() refuses a duplicate dedupKey after its savepoint, flips the waiting instance, and a wait consumes the oldest', async () => {
      const service = await DI.resolve(WorkflowService);
      await service.start('it-wait', null, { id: 'w' });
      await (await engine()).tick();
      expect((await instance('w')).Status).to.equal('waiting');
      expect(await service.signal('w', 'go', 1, { dedupKey: 'k' })).to.deep.equal({ accepted: true });
      expect(await service.signal('w', 'go', 2, { dedupKey: 'k' })).to.deep.equal({ accepted: false });
      // exact collation: a key that differs in case only is another key
      expect(await service.signal('w', 'go', 3, { dedupKey: 'K' })).to.deep.equal({ accepted: true });
      expect(pick(await instance('w'), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'running', WaitingFor: null });
      await (await engine()).tick();
      expect((await instance('w')).Result).to.equal(1);
      expect((await eventsOf('w')).map((e) => [e.Payload, e.State, e.ConsumedByKey])).to.deep.equal([
        [1, 'consumed', 'wait:go#1'],
        [3, 'pending', null],
      ]);
    });

    it('a * park wakes through signal() and through the signalled scan only for names with a pending wait', async () => {
      const service = await DI.resolve(WorkflowService);
      await service.start('it-race', null, { id: 'flip' });
      await service.start('it-race', null, { id: 'scan' });
      const r1 = await engine();
      await r1.tick();
      expect(pick(await instance('flip'), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'waiting', WaitingFor: '*' });
      await service.signal('flip', 'other', 1);
      await service.signal('flip', 'Reject', 1);
      expect((await instance('flip')).Status).to.equal('waiting');
      await service.signal('flip', 'reject', 2);
      expect((await instance('flip')).Status).to.equal('running');
      await seedEvent('scan', 'other');
      await seedEvent('scan', 'approve');
      await r1.tick();
      expect(pick(await instance('flip'), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'reject' });
      expect(pick(await instance('scan'), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'approve' });
    });

    it("the * key range excludes names that only start with the signalled one ('a$', 'ab' for 'a')", async () => {
      const service = await DI.resolve(WorkflowService);
      await service.start('it-near', null, { id: 'near' });
      const r1 = await engine();
      await r1.tick();
      await service.signal('near', 'a', 1);
      expect(pick(await instance('near'), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'waiting', WaitingFor: '*' });
      const attempt = (await instance('near')).Attempt;
      await r1.tick();
      expect((await instance('near')).Attempt).to.equal(attempt);
      await service.signal('near', 'ab', 2);
      await r1.tick();
      expect(pick(await instance('near'), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'ab' });
    });

    it('a compensation backs off as compensating, resumes from the due scan, and retry() finishes the pass', async () => {
      bank.down = true;
      const { clock } = await bootRealDb(target);
      const service = await DI.resolve(WorkflowService);
      await service.start('it-saga', null, { id: 's' });
      const r1 = await engine();
      await r1.tick();
      expect(pick(await instance('s'), 'Status', 'WakeAt')).to.deep.equal({ Status: 'compensating', WakeAt: T0 + 5_000 });
      clock.set(T0 + 5_000);
      await r1.tick();
      expect(pick(await instance('s'), 'Status', 'Reason')).to.deep.equal({ Status: 'failed', Reason: 'compensation-failed' });
      bank.down = false;
      await service.retry('s');
      await r1.tick();
      const done = await instance('s');
      expect(pick(done, 'Status', 'Reason')).to.deep.equal({ Status: 'compensated', Reason: 'error' });
      expect(done.Error?.message).to.equal('no courier');
      expect((await stepsOf('s')).map((r) => [r.Key, r.Seq, r.Status])).to.deep.equal([
        ['step:charge#1', 1, 'succeeded'],
        ['step:ship#1', 2, 'failed'],
        ['compensate:charge#1', 1_000_000, 'succeeded'],
      ]);
    });

    it('retry() resets the failed step rows in one transaction', async () => {
      await seedInstance('f', { Workflow: 'it-svc', Status: 'failed', Reason: 'error' });
      await seedStep('f', 1, 'step:bad#1', { Status: 'failed', Attempt: 3, Meta: { after: 0, order: 1 } });
      await (await DI.resolve(WorkflowService)).retry('f');
      expect(pick(await instance('f'), 'Status', 'Reason')).to.deep.equal({ Status: 'running', Reason: null });
      expect(pick((await stepsOf('f'))[0], 'Status', 'Attempt', 'Meta')).to.deep.equal({ Status: 'retrying', Attempt: 0, Meta: { after: 0 } });
    });
  });
}
