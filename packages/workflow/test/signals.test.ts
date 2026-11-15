import 'mocha';
import { expect } from 'chai';
import { DI } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { Workflow, WorkflowDefinition, WorkflowNotFound, WorkflowService, type WorkflowContext, type WorkflowEngine } from '../src/index.js';
import { activation } from './support/activation.js';
import { engine } from './support/engine.js';
import { bootTestEnv, disposeTestEnv } from './support/env.js';
import type { FakeClock } from '@spinajs/durable/testing';
import { eventsOf, instance, pick, rejects, seedEvent, seedInstance, stepsOf, T0 } from './support/rows.js';

const HOUR = 3_600_000;

@Workflow('sg-noop')
export class SgNoop extends WorkflowDefinition<null, string> {
  public run(): Promise<string> {
    return Promise.resolve('busy');
  }
}

@Workflow('sg-approve')
export class SgApprove extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    const e = await ctx.waitForEvent<{ ok: boolean }>('approved');
    return e?.payload;
  }
}

@Workflow('sg-two')
export class SgTwo extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    const a = await ctx.waitForEvent<string>('item');
    const b = await ctx.waitForEvent<string>('item');
    return [a?.payload, b?.payload];
  }
}

@Workflow('sg-timeout')
export class SgTimeout extends WorkflowDefinition<null, string> {
  public async run(ctx: WorkflowContext<null>): Promise<string> {
    const e = await ctx.waitForEvent('approved', { timeout: '1h' });
    return e === undefined ? 'timed-out' : 'approved';
  }
}

@Workflow('sg-race')
export class SgRace extends WorkflowDefinition<null, unknown> {
  public async run(ctx: WorkflowContext<null>): Promise<unknown> {
    const first = await ctx.waitForEvent<string>('go', { timeout: '1h' });
    const second = await ctx.waitForEvent<string>('go');
    return { first: first?.payload ?? null, second: second?.payload ?? null };
  }
}

describe('signals and waitForEvent', () => {
  let service: WorkflowService;
  let clock: FakeClock;
  let r1: WorkflowEngine;

  beforeEach(async () => {
    ({ clock } = await bootTestEnv());
    service = await DI.resolve(WorkflowService);
    r1 = await engine();
  });
  after(disposeTestEnv);

  it('a signal that arrives before the wait is buffered and consumed', async () => {
    const { id } = await service.start('sg-approve', null);
    expect(await service.signal(id, 'approved', { ok: true }, { principal: 'boss' })).to.deep.equal({ accepted: true });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: { ok: true } });
    const [event] = await eventsOf(id);
    expect(pick(event, 'State', 'ConsumedByKey', 'Principal', 'ReceivedAt')).to.deep.equal({ State: 'consumed', ConsumedByKey: 'wait:approved#1', Principal: 'boss', ReceivedAt: T0 });
    expect(pick((await stepsOf(id))[0], 'Key', 'Kind', 'Status', 'Result')).to.deep.equal({
      Key: 'wait:approved#1',
      Kind: 'wait',
      Status: 'succeeded',
      Result: { name: 'approved', payload: { ok: true }, receivedAt: T0, principal: 'boss' },
    });
  });

  it('two signals are consumed by two sequential waits, oldest first', async () => {
    const { id } = await service.start('sg-two', null);
    await service.signal(id, 'item', 'A');
    await service.signal(id, 'item', 'B');
    await r1.tick();
    expect((await instance(id)).Result).to.deep.equal(['A', 'B']);
    expect((await eventsOf(id)).map((e) => e.ConsumedByKey)).to.deep.equal(['wait:item#1', 'wait:item#2']);
    expect((await stepsOf(id)).map((s) => [s.Meta?.after, s.Meta?.order])).to.deep.equal([
      [0, 1],
      [1, 2],
    ]);
  });

  it('a wait without a signal parks the instance waiting; signal() makes it due at once', async () => {
    const { id } = await service.start('sg-approve', null);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor', 'WakeAt', 'ClaimedBy')).to.deep.equal({ Status: 'waiting', WaitingFor: 'approved', WakeAt: null, ClaimedBy: null });
    expect(pick((await stepsOf(id))[0], 'Key', 'Status', 'Meta')).to.deep.equal({ Key: 'wait:approved#1', Status: 'pending', Meta: { timeoutAt: null, after: 0 } });
    await service.signal(id, 'approved', { ok: true });
    expect(pick(await instance(id), 'Status', 'WaitingFor', 'WakeAt')).to.deep.equal({ Status: 'running', WaitingFor: null, WakeAt: null });
    await r1.tick();
    expect((await instance(id)).Result).to.deep.equal({ ok: true });
  });

  it('a signal of another name buffers without waking the instance', async () => {
    const { id } = await service.start('sg-approve', null);
    await r1.tick();
    expect(await service.signal(id, 'other', 1)).to.deep.equal({ accepted: true });
    expect(pick(await instance(id), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'waiting', WaitingFor: 'approved' });
  });

  it('a wait with a timeout resolves undefined at WakeAt', async () => {
    const { id } = await service.start('sg-timeout', null);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WakeAt')).to.deep.equal({ Status: 'waiting', WakeAt: T0 + HOUR });
    clock.set(T0 + HOUR);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: 'timed-out' });
    expect(pick((await stepsOf(id))[0], 'Status', 'ResultStored')).to.deep.equal({ Status: 'succeeded', ResultStored: false });
  });

  it('a duplicate dedupKey is not accepted and not stored twice', async () => {
    const { id } = await service.start('sg-approve', null);
    expect(await service.signal(id, 'approved', 1, { dedupKey: 'k' })).to.deep.equal({ accepted: true });
    expect(await service.signal(id, 'approved', 2, { dedupKey: 'k' })).to.deep.equal({ accepted: false });
    expect((await eventsOf(id)).map((e) => e.Payload)).to.deep.equal([1]);
  });

  it('a terminal instance accepts no signal; an unknown id is refused', async () => {
    const { id } = await service.start('sg-approve', null);
    await service.signal(id, 'approved', { ok: true });
    await r1.tick();
    expect(await service.signal(id, 'approved', { ok: false })).to.deep.equal({ accepted: false });
    expect((await eventsOf(id)).length).to.equal(1);
    expect(await rejects(service.signal('nope', 'approved', null))).to.be.instanceOf(WorkflowNotFound);
  });

  it('refuses a signal name the key columns cannot store exactly', async () => {
    const { id } = await service.start('sg-approve', null);
    for (const name of ['', 'approved ', 'x'.repeat(129), 'a\u0000b']) {
      expect(await rejects(service.signal(id, name, 1)), JSON.stringify(name)).to.be.instanceOf(InvalidArgument);
    }
    expect(await eventsOf(id)).to.have.length(0);
  });

  it("refuses '#' and '*' in signal and wait names", async () => {
    const { id } = await service.start('sg-approve', null);
    for (const name of ['a#b', '*']) expect(await rejects(service.signal(id, name, 1)), name).to.be.instanceOf(InvalidArgument);
    await seedInstance('names');
    const h = await activation('names');
    for (const name of ['a#b', '*']) expect(await rejects(h.ctx.waitForEvent(name)), name).to.be.instanceOf(InvalidArgument);
    await h.release();
    expect(await stepsOf('names')).to.have.length(0);
  });

  it('refuses a dedupKey over 128 characters or with edge whitespace', async () => {
    const { id } = await service.start('sg-approve', null);
    expect(await rejects(service.signal(id, 'approved', 1, { dedupKey: 'k'.repeat(129) }))).to.be.instanceOf(InvalidArgument);
    expect(await rejects(service.signal(id, 'approved', 1, { dedupKey: 'k ' }))).to.be.instanceOf(InvalidArgument);
    expect(await service.signal(id, 'approved', 1, { dedupKey: 'k'.repeat(128) })).to.deep.equal({ accepted: true });
  });

  it('refuses a principal over 200 characters', async () => {
    const { id } = await service.start('sg-approve', null);
    expect(await rejects(service.signal(id, 'approved', 1, { principal: 'p'.repeat(201) }))).to.be.instanceOf(InvalidArgument);
    expect(await service.signal(id, 'approved', 1, { principal: 'p'.repeat(200) })).to.deep.equal({ accepted: true });
  });

  it('stores an empty principal as none', async () => {
    const { id } = await service.start('sg-approve', null);
    await service.signal(id, 'approved', 1, { principal: '' });
    expect((await eventsOf(id))[0].Principal).to.equal(null);
  });

  it('refuses a payload JSON cannot represent', async () => {
    const { id } = await service.start('sg-approve', null);
    expect(await rejects(service.signal(id, 'approved', { n: 1n }))).to.be.instanceOf(InvalidArgument);
    expect(await eventsOf(id)).to.have.length(0);
  });

  it('a signal that landed while the instance was being parked is found by the next tick', async () => {
    const { id } = await service.start('sg-approve', null);
    await r1.tick();
    await seedEvent(id, 'approved', { Payload: { ok: true } });
    expect((await instance(id)).Status).to.equal('waiting');
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: { ok: true } });
  });

  it('a signalled wait gets a share of every tick, so due timers cannot starve it', async () => {
    const { id } = await service.start('sg-approve', null);
    await r1.tick();
    await seedEvent(id, 'approved', { Payload: { ok: true } });
    // five older due instances fill the timed query (and, on SQLite, the single slot); the signalled share still goes first
    for (let i = 0; i < 5; i++) await seedInstance(`busy-${i}`, { Workflow: 'sg-noop', UpdatedAt: T0 - 1000 });
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'Result')).to.deep.equal({ Status: 'completed', Result: { ok: true } });
  });

  it('timeout first: the first wait resolves undefined and a later signal goes to the next wait', async () => {
    const { id } = await service.start('sg-race', null);
    await r1.tick();
    clock.set(T0 + HOUR);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor', 'WakeAt')).to.deep.equal({ Status: 'waiting', WaitingFor: 'go', WakeAt: null });
    expect(await service.signal(id, 'go', 'late')).to.deep.equal({ accepted: true });
    await r1.tick();
    expect((await instance(id)).Result).to.deep.equal({ first: null, second: 'late' });
  });

  it('signal first: the flipped instance consumes it even when the timeout passed before the tick', async () => {
    const { id } = await service.start('sg-race', null);
    await r1.tick();
    expect(await service.signal(id, 'go', 'early')).to.deep.equal({ accepted: true });
    clock.set(T0 + 2 * HOUR);
    await r1.tick();
    expect(pick(await instance(id), 'Status', 'WaitingFor')).to.deep.equal({ Status: 'waiting', WaitingFor: 'go' });
    await service.signal(id, 'go', 'next');
    await r1.tick();
    expect((await instance(id)).Result).to.deep.equal({ first: 'early', second: 'next' });
  });
});
