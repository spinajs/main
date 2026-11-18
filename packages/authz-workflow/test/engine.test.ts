import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { TRUE } from '@spinajs/authz';
import { StaticModel } from '@spinajs/authz-testing';
import { SignalAuthorizer, Workflow, WorkflowDefinition, WorkflowEngine, WorkflowEventModel, WorkflowInstanceModel, WorkflowService, type WorkflowContext } from '@spinajs/workflow';
import { AuthzSignalAuthorizer } from '../src/index.js';
import { bootAuthzWorkflow, disposeAuthzWorkflow } from './support/env.js';

@Workflow('az-approval')
export class AzApproval extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    const e = await ctx.waitForEvent<{ ok: boolean }>('approved', { permission: 'orders:approve' });
    return e?.principal ?? 'none';
  }
}

const approvers = (): StaticModel => new StaticModel({ name: 'approvers', votes: (r) => (r.principal.id === 'approver' && r.permission === 'orders:approve' ? { permitWhen: TRUE } : {}) });

describe('authz-workflow with the engine', function () {
  this.timeout(30_000);

  let service: WorkflowService;
  let engine: WorkflowEngine;

  before(async () => {
    await bootAuthzWorkflow(approvers());
    service = await DI.resolve(WorkflowService);
    engine = await DI.resolve(WorkflowEngine, [{ replicaId: 'az' }]);
  });
  after(disposeAuthzWorkflow);

  const states = async (id: string) => (await WorkflowEventModel.where('InstanceId', id).orderBy('Id')).map((e) => e.State);

  it('is the registered SignalAuthorizer', async () => {
    expect(await DI.resolve(SignalAuthorizer)).to.be.instanceOf(AuthzSignalAuthorizer);
  });

  it('an allowed principal consumes the signal and the instance completes', async () => {
    const { id } = await service.start('az-approval', null);
    await engine.tick();
    await service.signal(id, 'approved', { ok: true }, { principal: 'user:approver' });
    await engine.tick();
    expect(await states(id)).to.deep.equal(['consumed']);
    expect((await WorkflowInstanceModel.where('Id', id).first()).Status).to.equal('completed');
  });

  it('a denied principal and a signal without principal are rejected and the instance keeps waiting', async () => {
    const { id } = await service.start('az-approval', null);
    await engine.tick();
    await service.signal(id, 'approved', { ok: true }, { principal: 'user:clerk' });
    await service.signal(id, 'approved', { ok: true });
    await engine.tick();
    expect(await states(id)).to.deep.equal(['rejected', 'rejected']);
    expect((await WorkflowInstanceModel.where('Id', id).first()).Status).to.equal('waiting');
  });
});
