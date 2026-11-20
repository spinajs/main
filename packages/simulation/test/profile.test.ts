import 'mocha';
import { expect } from 'chai';
import { Profiler, runSuite } from '../src/index.js';
import { schedulerSuite } from '../suites/scheduler.sim.js';

describe('profiling', function () {
  this.timeout(0);

  it('a disabled profiler returns no result and costs nothing', async () => {
    const p = new Profiler(false);
    expect(await p.time('bootMs', async () => 7)).to.equal(7);
    expect(p.result()).to.equal(undefined);
  });

  it('adds up phase times and counts', async () => {
    const p = new Profiler(true);
    await p.time('bootMs', () => new Promise((resolve) => setTimeout(resolve, 20)));
    p.count('ticks');
    p.count('ticks');
    p.bootedFrom('template');
    const r = p.result()!;
    expect(r.bootMs).to.be.at.least(15);
    expect([r.ticks, r.bootFrom]).to.deep.equal([2, 'template']);
  });

  it('takes the time of an inner phase out of the outer one', async () => {
    const p = new Profiler(true);
    await p.time('stepsMs', async () => {
      await p.time('settleMs', () => new Promise((resolve) => setTimeout(resolve, 60)));
    });
    const r = p.result()!;
    expect(r.settleMs).to.be.at.least(50);
    expect(r.stepsMs).to.be.below(30);
    expect(r.totalMs).to.be.at.least(r.stepsMs + r.settleMs);
  });

  it('reports the phases of a seed without changing its trace', async () => {
    const suite = schedulerSuite({ faults: [] });
    const plain = await runSuite(suite, 5, 40);
    const profiled = await runSuite({ ...suite, options: { ...suite.options, profile: true } }, 5, 40);
    expect(profiled.trace).to.deep.equal(plain.trace);
    expect(plain.profile).to.equal(undefined);
    const p = profiled.profile!;
    expect(p.ticks).to.be.greaterThan(0);
    expect(p.settleCalls).to.be.greaterThan(0);
    expect(['template', 'migrations']).to.include(p.bootFrom);
    // exclusive phases: together they never exceed the seed's wall time
    expect(p.totalMs).to.be.at.least(p.bootMs + p.buildMs + p.stepsMs + p.quiesceMs + p.checkMs + p.settleMs + p.shutdownMs - 1);
  });
});
