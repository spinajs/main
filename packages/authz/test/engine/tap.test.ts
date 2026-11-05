import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../src/engine/authorizer.js';
import { AuthzConfigError, DecisionTap, FALSE, TRUE } from '../../src/index.js';
import type { Decision, DecisionReadSet, DecisionRequest, EvaluationContext, ResourceFilter, Vote } from '../../src/index.js';
import { FakeAdapter, FakeRelation, RecordingAudit, RecordingLog, StaticModel, fakeClock, principal, registryOf } from './fakes.js';

const expect = chai.expect;

interface Tapped {
  readonly req: DecisionRequest;
  readonly decision: Decision;
  readonly reads: DecisionReadSet;
  readonly meta: { cached: boolean; durationMs: number };
}

class RecordingTap extends DecisionTap {
  readonly seen: Tapped[] = [];

  constructor(private readonly also?: (t: Tapped) => void) {
    super();
  }

  onDecision(req: DecisionRequest, decision: Decision, reads: DecisionReadSet, meta: { cached: boolean; durationMs: number }): void {
    const t = { req, decision, reads, meta };
    this.seen.push(t);
    this.also?.(t);
  }
}

class VersionedModel extends StaticModel {
  version(): string {
    return 'v7';
  }
}

const registry = registryOf([{ name: 'doc:read', types: ['doc'], list: true }]);
const alice = principal('user', 'alice', { attributes: { dept: 'eng' } });
const vote = (permitWhen: ResourceFilter, extra: Partial<Vote> = {}): Vote => ({ model: 'm', permitWhen, denyWhen: FALSE, cacheable: true, ...extra });
const adapter = () => new FakeAdapter(['doc', 'org'], { nodes: { 'doc:d1': { type: 'org', id: 'o1' }, 'org:o1': null }, scopeAttributes: { 'org:o1': { region: 'eu' } }, relations: [new FakeRelation('doc', 'owner', () => true)] });

function make(models: StaticModel[], taps: readonly DecisionTap[], options: Partial<AuthorizerOptions> = {}) {
  const audit = new RecordingAudit();
  const log = new RecordingLog();
  const a = new Authorizer({ domain: 'root', registry, models, adapters: [adapter()], audit, log, clock: fakeClock().clock, taps, config: { auditDenials: true }, ...options });
  return { a, audit, log };
}

describe('DecisionTap', () => {
  it('sees each top-level decision once, after finish has audited it', async () => {
    const audit = new RecordingAudit();
    let auditedBefore = 0;
    const tap = new RecordingTap(() => (auditedBefore = audit.entries.length));
    const { a: plain } = make([new StaticModel('m', { vote: vote(FALSE) })], []);
    const { a } = make([new StaticModel('m', { vote: vote(FALSE) })], [tap], { audit });
    const expected = await plain.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    const d = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    expect(d).to.deep.equal(expected);
    expect(tap.seen).to.have.length(1);
    expect(tap.seen[0].decision).to.equal(d);
    expect(Object.isFrozen(d)).to.equal(true);
    expect(auditedBefore).to.equal(1);
    expect(tap.seen[0].req).to.include({ permission: 'doc:read', principal: alice });
    expect(tap.seen[0].req.resource).to.deep.equal({ type: 'doc', id: 'd1' });
    expect(tap.seen[0].meta.cached).to.equal(false);
    expect(tap.seen[0].meta.durationMs).to.be.a('number').and.at.least(0);
  });

  it('marks an L1 hit as cached, with nothing read for it', async () => {
    const tap = new RecordingTap();
    const { a } = make([new VersionedModel('m', { vote: (req: DecisionRequest) => vote(req.env?.ip === '10.0.0.1' ? TRUE : FALSE) })], [tap]);
    const scope = { cache: new Map<string, unknown>() };
    await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } }, scope);
    await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } }, scope);
    expect(tap.seen.map((t) => t.meta.cached)).to.deep.equal([false, true]);
    expect(tap.seen[1].reads).to.deep.equal({ env: {}, attributes: [], relations: [], modelVersions: { m: 'v7' } });
  });

  it('records the env keys, attributes and relations a model reads and every model version', async () => {
    const tap = new RecordingTap();
    const model = new VersionedModel('m', {
      vote: async (req: DecisionRequest, ctx: EvaluationContext) => {
        const org = await ctx.attributes({ type: 'org', id: 'o1' });
        ctx.relation('doc', 'owner');
        return vote(req.env?.ip === '10.0.0.1' && org?.region === 'eu' ? TRUE : FALSE);
      },
    });
    const { a } = make([model], [tap]);
    const d = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, env: { ip: '10.0.0.1', unused: 1 } });
    expect(d.allowed).to.equal(true);
    const { reads } = tap.seen[0];
    expect(reads.env).to.deep.equal({ ip: '10.0.0.1' });
    expect(reads.attributes).to.deep.equal([{ ref: { type: 'org', id: 'o1' }, path: '', value: { region: 'eu' } }]);
    expect(reads.relations).to.deep.equal([{ model: 'm', object: { type: 'doc' }, relation: 'owner' }]);
    expect(reads.modelVersions).to.deep.equal({ m: 'v7' });
  });

  it('records the principal, actor and scope refs the engine binds', async () => {
    const tap = new RecordingTap();
    const when: ResourceFilter = {
      op: 'and',
      args: [
        { op: 'cmp', field: 'dept', cmp: 'eq', value: { ref: 'principal.attributes.dept' } },
        { op: 'cmp', field: 'region', cmp: 'eq', value: { ref: 'scope.org.region' } },
        { op: 'cmp', field: 'zone', cmp: 'eq', value: { ref: 'env.zone' } },
      ],
    };
    const { a } = make([new StaticModel('m', { vote: vote(when) })], [tap]);
    const d = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' }, env: { zone: 'z1' } });
    expect(d.residual).to.deep.equal({
      op: 'and',
      args: [
        { op: 'cmp', field: 'dept', cmp: 'eq', value: 'eng' },
        { op: 'cmp', field: 'region', cmp: 'eq', value: 'eu' },
        { op: 'cmp', field: 'zone', cmp: 'eq', value: 'z1' },
      ],
    });
    const { reads } = tap.seen[0];
    expect(reads.env).to.deep.equal({ zone: 'z1' });
    expect(reads.attributes).to.deep.include({ ref: 'principal', path: 'attributes.dept', value: 'eng' });
    expect(reads.attributes).to.deep.include({ ref: { type: 'org', id: 'o1' }, path: 'region', value: 'eu' });
  });

  it('a tap that throws or rejects is logged; the decision and the other taps go on', async () => {
    const after = new RecordingTap();
    const throwing = new RecordingTap(() => {
      throw new Error('tap down');
    });
    // Duck-typed, as a tap from another copy of the package would be; its promise reaches the engine.
    const rejecting = { onDecision: () => Promise.reject(new Error('tap rejected')) } as unknown as DecisionTap;
    const { a, log } = make([new StaticModel('m', { vote: vote(TRUE) })], [throwing, rejecting, after]);
    const d = await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(d.allowed).to.equal(true);
    expect(after.seen).to.have.length(1);
    const failures = log.at('error').filter((e) => /decision tap failed/.test(e.message));
    expect(failures.map((e) => e.error?.message)).to.deep.equal(['tap down', 'tap rejected']);
  });

  it('summary, covers, inspect, accessPlan and nested checks are not tapped; filter and filterNow are', async () => {
    const tap = new RecordingTap();
    const nested = new StaticModel('m', {
      vote: async (req: DecisionRequest, ctx: EvaluationContext) => (req.principal.id === 'bob' ? vote(TRUE) : vote((await ctx.check({ principal: principal('user', 'bob'), permission: 'doc:read', resource: req.resource })).allowed ? TRUE : FALSE)),
    });
    const { a } = make([nested], [tap]);
    await a.summary(alice);
    await a.covers(alice, principal('user', 'carol'));
    await a.inspect({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    expect(tap.seen).to.have.length(0);
    await a.check({ principal: alice, permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    await a.filter(alice, 'doc:read', 'doc');
    expect(tap.seen.map((t) => t.req.principal.id)).to.deep.equal(['alice', 'alice']);
  });

  it('without a tap the models get a plain env; with one, an env that records its reads', async () => {
    const descriptors: PropertyDescriptor[] = [];
    const model = () =>
      new StaticModel('m', {
        vote: (req: DecisionRequest) => {
          descriptors.push(Object.getOwnPropertyDescriptor(req.env ?? {}, 'ip')!);
          return vote(TRUE);
        },
      });
    await make([model()], []).a.check({ principal: alice, permission: 'doc:read', env: { ip: '10.0.0.1' } });
    await make([model()], [new RecordingTap()]).a.check({ principal: alice, permission: 'doc:read', env: { ip: '10.0.0.1' } });
    expect(descriptors[0]).to.include({ value: '10.0.0.1' });
    expect('get' in descriptors[1] && !('value' in descriptors[1])).to.equal(true);
  });

  it('refuses a tap without onDecision', () => {
    expect(() => make([], [{} as DecisionTap])).to.throw(AuthzConfigError, /onDecision/);
  });
});
