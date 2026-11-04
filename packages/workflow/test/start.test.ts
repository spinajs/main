import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { Workflow, WorkflowDefinition, WorkflowIdConflict, WorkflowInstanceModel, WorkflowNotRegistered, WorkflowService, workflowDriver } from '../src/index.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { instance, pick, rejects, T0 } from './support/rows.js';

@Workflow('st-order')
class StOrderV1 extends WorkflowDefinition<{ n: number }> {
  public run(): Promise<void> {
    return Promise.resolve();
  }
}

@Workflow('st-order', { version: 2 })
class StOrderV2 extends WorkflowDefinition<{ n: number }> {
  public run(): Promise<void> {
    return Promise.resolve();
  }
}

@Workflow('st-other')
class StOther extends WorkflowDefinition {
  public run(): Promise<void> {
    return Promise.resolve();
  }
}

describe('WorkflowService.start and get', () => {
  let service: WorkflowService;

  beforeEach(async () => {
    await bootTestEnv();
    service = await DI.resolve(WorkflowService);
  });
  after(disposeTestEnv);

  it('inserts a running instance of the highest version with its input', async () => {
    expect(await service.start('st-order', { n: 1 }, { id: 'o-1' })).to.deep.equal({ id: 'o-1', created: true });
    const row = await instance('o-1');
    expect(pick(row, 'Workflow', 'Version', 'Status', 'Attempt', 'ClaimEpoch', 'WakeAt', 'ClaimedBy', 'CancelRequested', 'CreatedAt', 'UpdatedAt')).to.deep.equal({
      Workflow: 'st-order',
      Version: 2,
      Status: 'running',
      Attempt: 0,
      ClaimEpoch: 0,
      WakeAt: null,
      ClaimedBy: null,
      CancelRequested: false,
      CreatedAt: T0,
      UpdatedAt: T0,
    });
    expect(row.Input).to.deep.equal({ n: 1 });
  });

  it('is idempotent on the id', async () => {
    await service.start('st-order', { n: 1 }, { id: 'o-1' });
    expect(await service.start('st-order', { n: 2 }, { id: 'o-1' })).to.deep.equal({ id: 'o-1', created: false });
    const rows = await WorkflowInstanceModel.where('Id', 'o-1');
    expect(rows.length).to.equal(1);
    expect(rows[0].Input).to.deep.equal({ n: 1 });
  });

  it('generates a uuid when no id is given', async () => {
    const { id, created } = await service.start(StOther, null);
    expect(created).to.equal(true);
    expect(id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('starts a class on its own version and a name on an explicit one', async () => {
    await service.start(StOrderV1, { n: 1 }, { id: 'by-class' });
    await service.start('st-order', { n: 1 }, { id: 'by-version', version: 1 });
    await service.start(StOrderV2, { n: 1 }, { id: 'by-class-2' });
    expect([(await instance('by-class')).Version, (await instance('by-version')).Version, (await instance('by-class-2')).Version]).to.deep.equal([1, 1, 2]);
  });

  it('refuses an id that another workflow already uses', async () => {
    await service.start('st-other', null, { id: 'shared' });
    const err = await rejects(service.start('st-order', { n: 1 }, { id: 'shared' }));
    expect(err).to.be.instanceOf(WorkflowIdConflict);
    expect(err.message).to.equal("workflow instance 'shared' already exists as 'st-other', not 'st-order'");
  });

  it('refuses an unregistered workflow', async () => {
    expect(await rejects(service.start('st-missing', null))).to.be.instanceOf(WorkflowNotRegistered);
  });

  it("joins the caller's transaction: a rollback leaves no instance", async () => {
    const driver = await workflowDriver();
    await rejects(
      driver.transaction(async () => {
        await service.start('st-order', { n: 1 }, { id: 'tx-1' });
        throw new Error('rollback');
      }),
    );
    expect(await instance('tx-1')).to.not.be.ok;
  });

  it('get() returns the instance view, undefined for an unknown id', async () => {
    await service.start('st-order', { n: 3 }, { id: 'o-3' });
    expect(await service.get('o-3')).to.deep.equal({
      id: 'o-3',
      workflow: 'st-order',
      version: 2,
      status: 'running',
      reason: null,
      input: { n: 3 },
      result: null,
      error: null,
      wakeAt: null,
      waitingFor: null,
      attempt: 0,
      cancelRequested: false,
      createdAt: T0,
      updatedAt: T0,
      finishedAt: null,
    });
    expect(await service.get('nope')).to.equal(undefined);
  });
});
