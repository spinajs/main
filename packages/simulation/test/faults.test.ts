import 'mocha';
import { expect } from 'chai';
import type { FaultPointName } from '@spinajs/durable';
import { runInContext, SimClock, SimCrash, SimFaults, SimRandom, SimReplicas, type FaultHit, type FaultRule, type SimContext } from '../src/index.js';

function world(rules: FaultRule[], seed = 1) {
  const clock = new SimClock(0);
  const replicas = new SimReplicas(clock);
  const faults = new SimFaults(rules, new SimRandom(seed));
  faults.attach({ now: () => clock.now(), isDead: (c) => replicas.isDead(c), crash: (c) => replicas.crash(c), park: (c, ms) => replicas.park(c, ms) });
  return { clock, replicas, faults, r1: replicas.context('r1'), r2: replicas.context('r2') };
}

const call = (faults: SimFaults, ctx: SimContext, name: FaultPointName = 'outbox.after-insert') => runInContext(ctx, () => faults.point(name));

describe('SimFaults', () => {
  it('does nothing outside a simulated replica', () => {
    const { faults } = world([{ point: 'outbox.after-insert', when: 'always', effect: 'crash' }]);
    expect(() => faults.point('outbox.after-insert')).not.to.throw();
    expect(faults.hits).to.deep.equal([]);
  });

  it('crashes the calling incarnation and keeps failing its leftover work', () => {
    const { faults, replicas, r1 } = world([{ point: 'outbox.after-insert', when: 'always', effect: 'crash' }]);
    expect(() => call(faults, r1)).to.throw(SimCrash);
    expect(faults.hits).to.deep.equal([{ point: 'outbox.after-insert', replica: 'r1', at: 0, effect: 'crash' }]);
    expect(replicas.isDead(r1)).to.equal(true);
    expect(() => call(faults, r1, 'outbox.before-mark')).to.throw(SimCrash);
    expect(faults.hits).to.have.length(1);
  });

  it('fires an nth rule once, on the nth call that reaches it', () => {
    const { faults, clock, r1 } = world([{ point: 'outbox.after-publish', when: { nth: 3 }, effect: 'duplicate' }]);
    for (let i = 0; i < 5; i++) {
      void call(faults, r1, 'outbox.after-publish');
      clock.advance(1);
    }
    expect(faults.hits).to.deep.equal([{ point: 'outbox.after-publish', replica: 'r1', at: 2, effect: 'duplicate' }]);
  });

  it('counts only the calls of the replica a rule names', () => {
    const { faults, r1, r2 } = world([{ point: 'outbox.after-publish', when: { nth: 1 }, effect: 'duplicate', replica: 'r2' }]);
    for (let i = 0; i < 3; i++) void call(faults, r1, 'outbox.after-publish');
    void call(faults, r2, 'outbox.after-publish');
    expect(faults.hits.map((h) => h.replica)).to.deep.equal(['r2']);
  });

  it('draws probabilities from the seeded generator', () => {
    const rules: FaultRule[] = [{ point: 'outbox.after-publish', when: { probability: 0.5 }, effect: 'duplicate' }];
    const run = (): FaultHit[] => {
      const { faults, clock, r1 } = world(rules, 9);
      for (let i = 0; i < 200; i++) {
        void call(faults, r1, 'outbox.after-publish');
        clock.advance(1);
      }
      return faults.hits;
    };
    const first = run();
    expect(run()).to.deep.equal(first);
    expect(first.length).to.be.within(70, 130);
  });

  it('parks on a delay until the replica thaws', async () => {
    const { faults, replicas, r1 } = world([{ point: 'workflow.after-step-fn', when: 'always', effect: 'delay', delayMs: 500 }]);
    const parked = call(faults, r1, 'workflow.after-step-fn') as Promise<void>;
    expect(replicas.isFrozen('r1')).to.equal(true);
    expect(replicas.due(500)).to.deep.equal(['r1']);
    replicas.thaw('r1');
    await parked;
    expect(faults.hits[0].effect).to.equal('delay');
  });

  it('hands a duplicate hit and its detail to the listeners', () => {
    const { faults, r1 } = world([{ point: 'outbox.after-publish', when: 'always', effect: 'duplicate' }]);
    const got: { hit: FaultHit; detail: unknown }[] = [];
    faults.onDuplicate((hit, detail) => got.push({ hit, detail }));
    void runInContext(r1, () => faults.point('outbox.after-publish', { messageId: 'm1' }));
    expect(got).to.deep.equal([{ hit: { point: 'outbox.after-publish', replica: 'r1', at: 0, effect: 'duplicate' }, detail: { messageId: 'm1' } }]);
  });

  it('stays quiet while disabled', () => {
    const { faults, r1 } = world([{ point: 'outbox.after-insert', when: 'always', effect: 'crash' }]);
    faults.enabled = false;
    expect(() => call(faults, r1)).not.to.throw();
    expect(faults.hits).to.deep.equal([]);
  });

  it('tries rules in order and the first that fires wins', () => {
    const { faults, r1, r2 } = world([
      { point: 'outbox.after-insert', when: { nth: 2 }, effect: 'crash' },
      { point: 'outbox.after-insert', when: 'always', effect: 'duplicate' },
    ]);
    void call(faults, r1);
    expect(() => call(faults, r2)).to.throw(SimCrash);
    expect(faults.hits.map((h) => h.effect)).to.deep.equal(['duplicate', 'crash']);
  });
});
