import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { DenyAllSignalAuthorizer, SignalAuthorizer, Workflow, WorkflowDefinition, WorkflowService, type WorkflowContext, type WorkflowEngine } from '../src/index.js';
import { TestSignalAuthorizer } from './support/authorizer.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import { eventsOf, instance, pick, stepsOf } from './support/rows.js';

@Workflow('au-approval')
export class AuApproval extends WorkflowDefinition<number, { by: string | null; note: string | null }> {
  public async run(ctx: WorkflowContext<number>): Promise<{ by: string | null; note: string | null }> {
    const e = await ctx.waitForEvent<string>('approved', { permission: 'orders:approve', resource: { order: ctx.input } });
    return { by: e?.principal ?? null, note: e?.payload ?? null };
  }
}

@Workflow('au-plain')
export class AuPlain extends WorkflowDefinition<null, string | null> {
  public async run(ctx: WorkflowContext<null>): Promise<string | null> {
    const e = await ctx.waitForEvent<string>('note');
    return e?.payload ?? null;
  }
}

describe('permissioned signals (D7)', () => {
  let service: WorkflowService;
  let r1: WorkflowEngine;

  beforeEach(async () => {
    TestSignalAuthorizer.reset();
    await bootTestEnv({ register: () => DI.register(TestSignalAuthorizer).as(SignalAuthorizer) });
    service = await DI.resolve(WorkflowService);
    r1 = await engine();
  });
  after(disposeTestEnv);

  it('fails closed: a permissioned signal nobody allows is rejected and the workflow keeps waiting', async () => {
    const { id } = await service.start('au-approval', 7);
    await service.signal(id, 'approved', 'go', { principal: 'alice' });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'waiting', WaitingFor: 'approved' });
    expect((await eventsOf(id)).map((e) => e.State)).to.deep.equal(['rejected']);
    expect(await new DenyAllSignalAuthorizer().authorize()).to.equal(false);
  });

  it("an allowed principal's signal is consumed; the authorizer sees principal, permission, resource and context", async () => {
    TestSignalAuthorizer.decide = (principal) => principal === 'boss';
    const { id } = await service.start('au-approval', 7);
    await service.signal(id, 'approved', 'ship it', { principal: 'boss' });
    await r1.tick();
    expect((await instance(id)).Result).to.deep.equal({ by: 'boss', note: 'ship it' });
    expect(TestSignalAuthorizer.calls).to.deep.equal([['boss', 'orders:approve', { order: 7 }, { instanceId: id, workflow: 'au-approval', event: 'approved' }]]);
  });

  it("a denied principal's event is rejected and the next allowed one completes the wait", async () => {
    TestSignalAuthorizer.decide = (principal) => principal === 'boss';
    const { id } = await service.start('au-approval', 7);
    await service.signal(id, 'approved', 'sneaky', { principal: 'mallory' });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'waiting', WaitingFor: 'approved' });
    await service.signal(id, 'approved', 'ok', { principal: 'boss' });
    await r1.tick();
    expect((await instance(id)).Result).to.deep.equal({ by: 'boss', note: 'ok' });
    expect((await eventsOf(id)).map((e) => [e.Principal, e.State])).to.deep.equal([
      ['mallory', 'rejected'],
      ['boss', 'consumed'],
    ]);
  });

  it('a replay asks with the permission and resource the first run recorded', async () => {
    TestSignalAuthorizer.decide = (principal) => principal === 'boss';
    const { id } = await service.start('au-approval', 7);
    await r1.tick();
    expect(pick((await stepsOf(id))[0], 'Status', 'Meta')).to.deep.equal({ Status: 'pending', Meta: { timeoutAt: null, permission: 'orders:approve', resource: { order: 7 }, after: 0 } });
    await service.signal(id, 'approved', 'later', { principal: 'boss' });
    await r1.tick();
    expect((await instance(id)).Result).to.deep.equal({ by: 'boss', note: 'later' });
    expect(TestSignalAuthorizer.calls.map((c) => c.slice(1, 3))).to.deep.equal([['orders:approve', { order: 7 }]]);
  });

  it('a wait without a permission never asks the authorizer', async () => {
    TestSignalAuthorizer.decide = () => {
      throw new Error('must not be asked');
    };
    const { id } = await service.start('au-plain', null);
    await service.signal(id, 'note', 'hello');
    await r1.tick();
    expect((await instance(id)).Result).to.equal('hello');
    expect(TestSignalAuthorizer.calls).to.deep.equal([]);
  });
});
