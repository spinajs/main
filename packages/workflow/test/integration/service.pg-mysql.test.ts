import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Workflow, WorkflowDefinition, WorkflowService } from '../../src/index.js';
import { disposeTestEnv } from '../support/env.js';
import { instance, pick, seedInstance, seedStep, stepsOf, T0 } from '../support/rows.js';
import { bootRealDb, REAL_DB_TARGETS } from './real-db.js';

@Workflow('it-svc')
export class ItSvc extends WorkflowDefinition<null, string> {
  public run(): Promise<string> {
    return Promise.resolve('ok');
  }
}

for (const target of REAL_DB_TARGETS) {
  (target.enabled ? describe : describe.skip)(`workflow service (${target.name})`, function () {
    this.timeout(60_000);

    beforeEach(() => bootRealDb(target));
    after(disposeTestEnv);

    it('health() groups unfinished instances by version', async () => {
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

    it('retry() resets the failed step rows in one transaction', async () => {
      await seedInstance('f', { Workflow: 'it-svc', Status: 'failed', Reason: 'error' });
      await seedStep('f', 1, 'step:bad#1', { Status: 'failed', Attempt: 3, Meta: { after: 0, order: 1 } });
      await (await DI.resolve(WorkflowService)).retry('f');
      expect(pick(await instance('f'), 'Status', 'Reason')).to.deep.equal({ Status: 'running', Reason: null });
      expect(pick((await stepsOf('f'))[0], 'Status', 'Attempt', 'Meta')).to.deep.equal({ Status: 'retrying', Attempt: 0, Meta: { after: 0 } });
    });
  });
}
