import { DI } from '@spinajs/di';
import { GLOBAL } from '@spinajs/authz';
import { ManualClock, fakeEvaluationContext } from '@spinajs/authz-testing';
import { Perf, PerfSink } from '@spinajs/log-common';
import type { IPerfMetric } from '@spinajs/log-common';
import * as chai from 'chai';
import 'mocha';

import { AssignmentCache, AssignmentStore, isLive, subjectKey } from '../../src/index.js';
import type { Assignment, AssignmentSubject } from '../../src/contracts.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const alice: AssignmentSubject = { type: 'user', id: 'alice' };
const bob: AssignmentSubject = { type: 'user', id: 'bob' };

const HIT = 'authz.rbac.assignments.hit';
const MISS = 'authz.rbac.assignments.miss';

const row = (id: string, subject: AssignmentSubject): Assignment => ({ id, subject, role: 'viewer', scope: GLOBAL, source: 'test' });

class CapturingSink extends PerfSink {
  static metrics: IPerfMetric[] = [];
  public collect(metric: IPerfMetric): void {
    CapturingSink.metrics.push(metric);
  }
}

class MemoryStore extends AssignmentStore {
  readonly name = 'memory';
  constructor(private readonly rows: Assignment[]) {
    super();
  }
  async forSubjects(subjects: readonly AssignmentSubject[], at: Date): Promise<readonly Assignment[]> {
    const keys = subjects.map(subjectKey);
    return this.rows.filter((a) => keys.includes(subjectKey(a.subject)) && isLive(a, at));
  }
  async holders(): Promise<readonly AssignmentSubject[]> {
    return [];
  }
  async byId(): Promise<Assignment | null> {
    return null;
  }
}

const request = () => fakeEvaluationContext({ now: NOW });
const names = () => CapturingSink.metrics.map((m) => m.name);
const count = (name: string) => CapturingSink.metrics.filter((m) => m.name === name).length;

describe('authz-rbac model: AssignmentCache perf counters', () => {
  const setup = () => new AssignmentCache(new MemoryStore([row('a1', alice), row('b1', bob)]), { ttlMs: 60_000, maxEntries: 100, clock: new ManualClock(NOW), model: 'rbac' });

  beforeEach(() => {
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

  it('counts one miss for a read that goes to the store', async () => {
    await setup().read([alice], request());
    expect(names()).to.deep.equal([MISS]);
    expect(CapturingSink.metrics[0].kind).to.equal('counter');
  });

  it('counts one hit for a read another request already loaded', async () => {
    const cache = setup();
    await cache.read([alice], request());
    CapturingSink.metrics = [];
    await cache.read([alice], request());
    expect(names()).to.deep.equal([HIT]);
  });

  it('counts one hit for a repeat read inside the same request', async () => {
    const cache = setup();
    const ctx = request();
    await cache.read([alice], ctx);
    CapturingSink.metrics = [];
    await cache.read([alice], ctx);
    expect(names()).to.deep.equal([HIT]);
  });

  it('counts one miss, not one per subject, when only some subjects are cached', async () => {
    const cache = setup();
    await cache.read([alice], request());
    CapturingSink.metrics = [];
    await cache.read([alice, bob], request());
    expect(count(MISS)).to.equal(1);
    expect(count(HIT)).to.equal(0);
  });

  it('counts a miss for a fresh read and again after an invalidate', async () => {
    const cache = setup();
    await cache.read([alice], request());
    CapturingSink.metrics = [];
    await cache.read([alice], request(), { fresh: true });
    expect(names()).to.deep.equal([MISS]);
    CapturingSink.metrics = [];
    cache.invalidate(['subject:user:alice']);
    await cache.read([alice], request());
    expect(names()).to.deep.equal([MISS]);
  });

  it('emits nothing when Perf is disabled', async () => {
    Perf.Enabled = false;
    const cache = setup();
    await cache.read([alice], request());
    await cache.read([alice], request());
    expect(CapturingSink.metrics).to.have.length(0);
  });
});
