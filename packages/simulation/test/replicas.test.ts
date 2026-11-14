import 'mocha';
import { expect } from 'chai';
import { runInContext, SimClock, SimCrash, SimReplicas } from '../src/index.js';

const rejection = (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

describe('SimReplicas', () => {
  let clock: SimClock;
  let replicas: SimReplicas;

  beforeEach(() => {
    clock = new SimClock(0);
    replicas = new SimReplicas(clock);
  });

  it('starts a replica at incarnation 1 and gives a restart a new incarnation', () => {
    const first = replicas.context('r1');
    expect(first).to.deep.equal({ replica: 'r1', incarnation: 1 });
    replicas.crash(first);
    expect(replicas.isCrashed('r1')).to.equal(true);
    expect(replicas.isDead(first)).to.equal(true);
    const second = replicas.restart('r1');
    expect(second).to.deep.equal({ replica: 'r1', incarnation: 2 });
    expect(replicas.isCrashed('r1')).to.equal(false);
    expect(replicas.isDead(first)).to.equal(true);
    expect(replicas.isDead(second)).to.equal(false);
  });

  it('drops the timers of a live incarnation when it restarts', () => {
    const fired: string[] = [];
    runInContext(replicas.context('r1'), () => clock.setTimeout(() => fired.push('old'), 5));
    replicas.restart('r1');
    clock.advance(10);
    expect(fired).to.deep.equal([]);
  });

  it('parks until the freeze ends and reports the replica as due then', async () => {
    const ctx = replicas.context('r1');
    let resumed = false;
    const parked = replicas.park(ctx, 1000).then(() => (resumed = true));
    expect(replicas.isFrozen('r1')).to.equal(true);
    expect(replicas.due(999)).to.deep.equal([]);
    expect(replicas.due(1000)).to.deep.equal(['r1']);
    expect(replicas.nextThaw(5000)).to.equal(1000);
    expect(replicas.nextThaw(500)).to.equal(null);
    replicas.thaw('r1');
    await parked;
    expect(resumed).to.equal(true);
    expect(replicas.isFrozen('r1')).to.equal(false);
  });

  it('tells a waiter about the next park, and not after cancel', async () => {
    const wait = replicas.whenParked('r1');
    void replicas.park(replicas.context('r1'), 10);
    expect(await wait.parked).to.equal('parked');
    const cancelled = replicas.whenParked('r2');
    cancelled.cancel();
    void replicas.park(replicas.context('r2'), 10);
    const raced = await Promise.race([cancelled.parked, new Promise<'none'>((resolve) => setImmediate(() => resolve('none')))]);
    expect(raced).to.equal('none');
  });

  it('fails parked work and drops timers when the incarnation crashes', async () => {
    const ctx = replicas.context('r1');
    const fired: string[] = [];
    runInContext(ctx, () => clock.setTimeout(() => fired.push('dead timer'), 5));
    const parked = replicas.park(ctx, 1000);
    replicas.crash(ctx);
    expect(await rejection(parked)).to.be.instanceOf(SimCrash);
    clock.advance(10);
    expect(fired).to.deep.equal([]);
    expect(replicas.isFrozen('r1')).to.equal(false);
  });

  it('refuses to park a dead incarnation', async () => {
    const ctx = replicas.context('r1');
    replicas.crash(ctx);
    expect(await rejection(replicas.park(ctx, 10))).to.be.instanceOf(SimCrash);
  });

  it('keeps one deferred park per incarnation, the longest, and drops it on a crash', () => {
    const ctx = replicas.context('r1');
    replicas.deferPark(ctx, 300);
    replicas.deferPark(ctx, 500);
    replicas.deferPark(ctx, 100);
    expect(replicas.isFrozen('r1')).to.equal(false);
    expect(replicas.takeDeferredPark(ctx)).to.equal(500);
    expect(replicas.takeDeferredPark(ctx)).to.equal(undefined);
    replicas.deferPark(ctx, 200);
    replicas.crash(ctx);
    expect(replicas.takeDeferredPark(ctx)).to.equal(undefined);
    expect(replicas.takeDeferredPark(replicas.restart('r1'))).to.equal(undefined);
  });

  it('extends a freeze to the later end and reports the latest freeze', () => {
    replicas.freeze('r1', 500);
    replicas.freeze('r1', 300);
    replicas.freeze('r2', 900);
    expect(replicas.due(500)).to.deep.equal(['r1']);
    expect(replicas.latestFreeze()).to.equal(900);
  });

  it('crashAll kills every live incarnation', () => {
    const a = replicas.context('a');
    const b = replicas.context('b');
    replicas.crashAll();
    expect(replicas.isDead(a) && replicas.isDead(b)).to.equal(true);
  });
});
