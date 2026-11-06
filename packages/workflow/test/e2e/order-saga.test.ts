import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { NonRetryableError } from '@spinajs/durable';
import { SignalAuthorizer, Workflow, WorkflowDefinition, WorkflowService, type WorkflowContext, type WorkflowEngine } from '../../src/index.js';
import { TestSignalAuthorizer } from '../support/authorizer.js';
import { engine } from '../support/engine.js';
import { bootTestEnv, disposeTestEnv } from '../support/env.js';
import { eventsOf, instance, pick, stepsOf } from '../support/rows.js';

interface Order {
  order: string;
  amount: number;
}

let effects: string[] = [];
const courier = { available: true };

@Workflow('order-saga')
export class OrderSaga extends WorkflowDefinition<Order, string> {
  public async run(ctx: WorkflowContext<Order>): Promise<string> {
    const charge = await ctx.step(
      'charge',
      () => {
        effects.push(`charge:${ctx.input.amount}`);
        return `ch-${ctx.input.order}`;
      },
      {
        compensate: async (id) => {
          effects.push(`refund:${id}`);
        },
      },
    );
    const reservation = await ctx.step(
      'reserve',
      () => {
        effects.push('reserve');
        return `rs-${ctx.input.order}`;
      },
      {
        compensate: async (id) => {
          effects.push(`release:${id}`);
        },
      },
    );
    const approval = await ctx.waitForEvent<{ note: string }>('approval', { permission: 'orders:approve', resource: { order: ctx.input.order } });
    await ctx.step('ship', () => {
      if (!courier.available) throw new NonRetryableError('no courier');
      effects.push(`ship:${reservation}:${approval?.principal}`);
    });
    return `shipped:${charge}`;
  }
}

describe('e2e: order saga (W5 milestone)', () => {
  let service: WorkflowService;
  let r1: WorkflowEngine;

  beforeEach(async () => {
    effects = [];
    courier.available = true;
    TestSignalAuthorizer.reset();
    TestSignalAuthorizer.decide = (principal, permission, resource) => principal === 'manager' && permission === 'orders:approve' && resource?.order === 'A-1';
    await bootTestEnv({ register: () => DI.register(TestSignalAuthorizer).as(SignalAuthorizer) });
    service = await DI.resolve(WorkflowService);
    r1 = await engine();
  });
  after(disposeTestEnv);

  it('charges, reserves, waits for an authorized approval and ships', async () => {
    const { id } = await service.start('order-saga', { order: 'A-1', amount: 42 });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'waiting', WaitingFor: 'approval' });
    expect(await service.signal(id, 'approval', { note: 'ok' }, { principal: 'intern' })).to.deep.equal({ accepted: true });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'waiting', WaitingFor: 'approval' });
    await service.signal(id, 'approval', { note: 'ok' }, { principal: 'manager' });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'shipped:ch-A-1' });
    expect((await eventsOf(id)).map((e) => [e.Principal, e.State])).to.deep.equal([
      ['intern', 'rejected'],
      ['manager', 'consumed'],
    ]);
    expect(effects).to.deep.equal(['charge:42', 'reserve', 'ship:rs-A-1:manager']);
  });

  it('a failed shipment compensates the reservation, then the charge', async () => {
    courier.available = false;
    const { id } = await service.start('order-saga', { order: 'A-1', amount: 42 });
    await r1.tick();
    await service.signal(id, 'approval', { note: 'ok' }, { principal: 'manager' });
    await r1.tick();
    const row = await instance(id);
    expect(pick(row, 'Status', 'Reason')).to.deep.equal({ Status: 'compensated', Reason: 'error' });
    expect(pick(row.Error!, 'name', 'message', 'step')).to.deep.equal({ name: 'NonRetryableError', message: 'no courier', step: 'ship' });
    expect(effects).to.deep.equal(['charge:42', 'reserve', 'release:rs-A-1', 'refund:ch-A-1']);
    expect((await stepsOf(id)).map((s) => [s.Key, s.Status])).to.deep.equal([
      ['step:charge#1', 'succeeded'],
      ['step:reserve#1', 'succeeded'],
      ['wait:approval#1', 'succeeded'],
      ['step:ship#1', 'failed'],
      ['compensate:reserve#1', 'succeeded'],
      ['compensate:charge#1', 'succeeded'],
    ]);
  });
});
