import { DI } from '@spinajs/di';
import { Perf, PerfSink } from '@spinajs/log-common';
import type { IPerfMetric } from '@spinajs/log-common';
import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { LruDecisionCache } from '../../src/engine/cache.js';
import { TRUE } from '../../src/index.js';
import { RecordingAudit, RecordingLog, StaticModel, fakeClock, permit, principal, registryOf } from '../engine/fakes.js';

const expect = chai.expect;

const REG = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const alice = principal('user', 'alice');
const input = { principal: alice, permission: 'doc:read' };

const CHECK = 'authz.check';
const L1_HIT = 'authz.cache.l1.hit';
const L2_HIT = 'authz.cache.l2.hit';
const MISS = 'authz.cache.miss';

class CapturingSink extends PerfSink {
  static metrics: IPerfMetric[] = [];
  public collect(metric: IPerfMetric): void {
    CapturingSink.metrics.push(metric);
  }
}

const count = (name: string) => CapturingSink.metrics.filter((m) => m.name === name).length;
const authzMetrics = () => CapturingSink.metrics.filter((m) => m.name.startsWith('authz.')).map((m) => m.name);

describe('Authorizer perf metrics', () => {
  let clock: ReturnType<typeof fakeClock>;

  const make = (options: Partial<AuthorizerOptions> = {}): Authorizer => {
    const model = new StaticModel('m', { vote: permit(TRUE, { cacheable: true }) });
    return new Authorizer({ domain: 'root', models: [model], registry: REG, clock: clock.clock, log: new RecordingLog(), audit: new RecordingAudit(), cache: new LruDecisionCache({ clock: clock.clock }), ...options });
  };

  beforeEach(() => {
    clock = fakeClock();
    CapturingSink.metrics = [];
    Perf.Enabled = true;
    DI.register(CapturingSink).as(PerfSink);
    Perf.refreshSinks();
  });

  afterEach(() => {
    DI.unregister(PerfSink, CapturingSink);
    Perf.refreshSinks();
    Perf.Enabled = true;
  });

  it('times a check once as a span labelled with the domain', async () => {
    await make().check(input, { cache: new Map() });
    const spans = CapturingSink.metrics.filter((m) => m.name === CHECK);
    expect(spans).to.have.length(1);
    expect(spans[0].kind).to.equal('span');
    expect(spans[0].labels).to.deep.equal({ domain: 'root' });
    expect(spans[0].durationMs).to.be.a('number');
  });

  it('counts one miss and no hit for a check no cache answers', async () => {
    await make().check(input, { cache: new Map() });
    expect(authzMetrics()).to.deep.equal([MISS, CHECK]);
  });

  it('counts an L1 hit when the request already decided the same check', async () => {
    const a = make();
    const scope = { cache: new Map<string, unknown>() };
    await a.check(input, scope);
    CapturingSink.metrics = [];
    await a.check(input, scope);
    expect(authzMetrics()).to.deep.equal([L1_HIT, CHECK]);
  });

  it('counts an L2 hit when another request decided it', async () => {
    const a = make();
    await a.check(input, { cache: new Map() });
    CapturingSink.metrics = [];
    await a.check(input, { cache: new Map() });
    expect(authzMetrics()).to.deep.equal([L2_HIT, CHECK]);
  });

  it('counts a miss again once the cached decision has expired', async () => {
    const a = make();
    await a.check(input, { cache: new Map() });
    clock.advance(24 * 3600 * 1000);
    CapturingSink.metrics = [];
    await a.check(input, { cache: new Map() });
    expect(count(MISS)).to.equal(1);
    expect(count(L1_HIT) + count(L2_HIT)).to.equal(0);
  });

  it('still emits the span when the check throws', async () => {
    let thrown: unknown;
    try {
      await make().check({ principal: alice, permission: 'doc:unknown' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.be.instanceOf(Error);
    const spans = CapturingSink.metrics.filter((m) => m.name === CHECK);
    expect(spans).to.have.length(1);
    expect(spans[0].error).to.equal(thrown);
  });

  it('emits nothing when Perf is disabled', async () => {
    Perf.Enabled = false;
    const a = make();
    const scope = { cache: new Map<string, unknown>() };
    await a.check(input, scope);
    await a.check(input, scope);
    await a.check(input, { cache: new Map() });
    expect(CapturingSink.metrics).to.have.length(0);
  });
});
