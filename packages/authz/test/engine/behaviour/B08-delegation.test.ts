import * as chai from 'chai';
import 'mocha';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../../src/engine/authorizer.js';
import { AuthzConfigError, FALSE, SYSTEM, TRUE, UNATTENDED, and, or } from '../../../src/index.js';
import type { DecisionRequest, EvaluationContext, Principal, ResourceFilter, Vote } from '../../../src/index.js';
import { FakeAdapter, FakeRelation, FakeRow, RecordingAudit, StaticModel, fakeClock, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const cmp = (field: string, value: string): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value });
const owner: ResourceFilter = { op: 'relation', relation: 'owner' };
const pass = (model: string, permitWhen: ResourceFilter, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen, denyWhen: FALSE, cacheable: true, ...extra });

type Grants = Readonly<Record<string, ResourceFilter | undefined>>;

/** Permits per principal id; a principal with no entry gets a reason. */
const byId = (grants: Grants, name = 'm') =>
  new StaticModel(name, {
    vote: (req: DecisionRequest) => {
      const when = grants[req.principal.id];
      return when ? pass(name, when) : pass(name, FALSE, { reason: { code: 'role_too_low' } });
    },
  });

const rows = [new FakeRow('doc', 'd1', { owner: 'bob', team: 'red' })];

const setup = (models: StaticModel[], options: Partial<AuthorizerOptions> = {}) => {
  const audit = new RecordingAudit();
  const adapter = new FakeAdapter(['doc'], { rows, relations: [new FakeRelation('doc', 'owner', (p, _ref, subject) => (subject as FakeRow).owner === p.id)] });
  const a = new Authorizer({ domain: 'root', registry, models, adapters: [adapter], audit, clock: fakeClock().clock, ...options });
  return { a, audit, adapter };
};

const bob = principal('user', 'bob');
const token = (delegate: unknown, extra: Partial<Principal> = {}): Principal => principal('token', 't1', { onBehalfOf: delegate as Principal, ...extra });

describe('B08: onBehalfOf with intersect delegation', () => {
  it('B08: allowed only when the delegate is allowed too; residuals are AND-ed', async () => {
    const { a } = setup([byId({ t1: cmp('team', 'red'), bob: cmp('state', 'open') })]);
    const d = await a.check({ principal: token(bob), permission: 'doc:read' });
    expect(d.allowed).to.equal(true);
    expect(d.residual).to.deep.equal(and(cmp('team', 'red'), cmp('state', 'open')));
    expect(await a.filter(token(bob), 'doc:read', 'doc')).to.deep.equal(d.residual);
    expect(a.filterNow(token(bob), 'doc:read', 'doc')).to.deep.equal(d.residual);
  });

  it('B08: a denied delegate denies with delegate (200, delegate key); the principal still runs the models', async () => {
    const m = byId({ t1: TRUE });
    const { a } = setup([m]);
    const d = await a.check({ principal: token(bob), permission: 'doc:read' });
    expect(d.allowed).to.equal(false);
    expect(d.residual).to.equal(FALSE);
    expect(d.reason).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'user:bob' });
    expect(m.calls.map((c) => c.req.principal.id).sort()).to.deep.equal(['bob', 't1']);
  });

  it("B08: the principal's own lower-priority reason wins over the delegate denial", async () => {
    const m = new StaticModel('m', { vote: (req) => (req.principal.id === 't1' ? { model: 'm', permitWhen: FALSE, denyWhen: TRUE, denies: [{ when: TRUE, reason: { code: 'agents_disabled', priority: 100 } }], cacheable: true } : pass('m', FALSE)) });
    const d = await setup([m]).a.check({ principal: token(bob), permission: 'doc:read' });
    expect(d.reason).to.deep.equal({ code: 'agents_disabled', priority: 100, model: 'm' });
  });

  it('B08: a denied principal stays denied when the delegate is allowed', async () => {
    const d = await setup([byId({ bob: TRUE })]).a.check({ principal: token(bob), permission: 'doc:read' });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'role_too_low', model: 'm' });
  });

  it("B08: relation and native ops of another principal's residual are stripped fail-closed", async () => {
    const { a } = setup([byId({ t1: TRUE, bob: or(owner, cmp('team', 'red')) })]);
    expect((await a.check({ principal: token(bob), permission: 'doc:read' })).residual).to.deep.equal(cmp('team', 'red'));
    const only = await setup([byId({ t1: TRUE, bob: owner })]).a.check({ principal: token(bob), permission: 'doc:read' });
    expect(only.allowed).to.equal(false);
    expect(only.reason).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'user:bob' });
  });

  it('B08: a delegate with the same key keeps its principal ops', async () => {
    const alice = principal('user', 'alice', { onBehalfOf: principal('user', 'alice') });
    const d = await setup([byId({ alice: owner })]).a.check({ principal: alice, permission: 'doc:read' });
    expect(d.residual).to.deep.equal(owner);
  });

  it("B08: with a subject the delegate's relation is evaluated for the delegate", async () => {
    const { a } = setup([byId({ t1: TRUE, bob: owner })]);
    expect((await a.check({ principal: token(bob), permission: 'doc:read', resource: rows[0] })).allowed).to.equal(true);
    const carol = await a.check({ principal: token(principal('user', 'carol')), permission: 'doc:read', resource: rows[0] });
    expect(carol.allowed).to.equal(false);
    expect(carol.reason).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'user:carol' });
  });

  it('B08: delegation deeper than maxDelegation throws AuthzConfigError; a cycle too', async () => {
    const { a } = setup([byId({ t1: TRUE, bob: TRUE, carol: TRUE, dave: TRUE })]);
    const chain2 = token(principal('user', 'bob', { onBehalfOf: principal('user', 'carol') }));
    expect((await a.check({ principal: chain2, permission: 'doc:read' })).allowed).to.equal(true);
    const chain3 = token(principal('user', 'bob', { onBehalfOf: principal('user', 'carol', { onBehalfOf: principal('user', 'dave') }) }));
    await expectReject(a.check({ principal: chain3, permission: 'doc:read' }), AuthzConfigError);
    expect(() => a.filterNow(chain3, 'doc:read', 'doc')).to.throw(AuthzConfigError);
    await expectReject(setup([byId({ t1: TRUE, bob: TRUE })], { config: { maxDelegation: 0 } }).a.check({ principal: token(bob), permission: 'doc:read' }), AuthzConfigError);
    const loop: { -readonly [K in keyof Principal]: Principal[K] } = principal('user', 'x');
    loop.onBehalfOf = token(loop);
    await expectReject(a.check({ principal: loop, permission: 'doc:read' }), AuthzConfigError);
  });

  it('B08: every link of the chain must allow: a denial two hops down denies the request', async () => {
    const { a } = setup([byId({ t1: TRUE, bob: TRUE })]);
    const d = await a.check({ principal: token(principal('user', 'bob', { onBehalfOf: principal('user', 'carol') })), permission: 'doc:read' });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'user:bob' });
  });

  it("B08: the delegate's own ceiling applies through its check", async () => {
    const d = await setup([byId({ t1: TRUE, bob: TRUE })]).a.check({ principal: token(principal('user', 'bob', { ceiling: { permissions: [] } })), permission: 'doc:read' });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'user:bob' });
  });

  it('B08: SYSTEM, UNATTENDED, forged or unreadable delegates deny delegate without running the models', async () => {
    const throwing = Object.defineProperty({ type: 'user', authenticated: true, source: 's', attributes: {} }, 'id', {
      get() {
        throw new Error('boom');
      },
      enumerable: true,
    });
    for (const delegate of [SYSTEM, UNATTENDED, { ...SYSTEM }, principal('unattended', 'u'), throwing, 'bob']) {
      const m = byId({ t1: TRUE, bob: TRUE });
      const d = await setup([m]).a.check({ principal: token(delegate), permission: 'doc:read' });
      expect(d.allowed).to.equal(false);
      expect(d.reason?.code).to.equal('delegate');
      expect(d.reason?.priority).to.equal(200);
      expect(m.calls).to.have.length(0);
    }
  });

  it('B08: Decision.principal is the request principal, the actor is the input actor, the audit names the request principal', async () => {
    const { a, audit } = setup([byId({ t1: TRUE })]);
    const agent = principal('agent', 'bot');
    const d = await a.check({ principal: token(bob), actor: agent, permission: 'doc:read' });
    expect(d.principal).to.deep.equal({ type: 'token', id: 't1' });
    expect(d.actor).to.deep.equal({ type: 'agent', id: 'bot' });
    expect(audit.entries).to.deep.equal([{ kind: 'deny', principal: { type: 'token', id: 't1' }, permission: 'doc:read', resource: { type: 'doc' }, reason: 'delegate' }]);
  });

  it("B08: the delegate's check shares the request scope (ancestors read once) and validUntil takes the minimum", async () => {
    const soon = new Date('2026-10-01T13:00:00Z');
    const m = new StaticModel('m', { vote: (req: DecisionRequest) => pass('m', TRUE, req.principal.id === 'bob' ? { validUntil: soon } : {}) });
    const { a, adapter } = setup([m]);
    const d = await a.check({ principal: token(bob), permission: 'doc:read', resource: { type: 'doc', id: 'd1' } });
    expect(d.allowed).to.equal(true);
    expect(d.validUntil?.toISOString()).to.equal(soon.toISOString());
    expect(adapter.ancestorCalls).to.have.length(1);
  });

  it("B08: the delegate's check reuses the resolved ref and subject (refOf runs once)", async () => {
    class LooseAdapter extends FakeAdapter {
      accepts(target: unknown): target is FakeRow {
        return target !== null && typeof target === 'object';
      }
    }
    const adapter = new LooseAdapter(['doc'], { rows, relations: [new FakeRelation('doc', 'owner', (p, _ref, subject) => (subject as FakeRow).owner === p.id)] });
    const a = new Authorizer({ domain: 'root', registry, models: [byId({ t1: TRUE, bob: owner })], adapters: [adapter] });
    const d = await a.check({ principal: token(bob), permission: 'doc:read', resource: rows[0] });
    expect(d.allowed).to.equal(true);
    expect(adapter.refOfCalls).to.deep.equal([rows[0]]);
  });

  it('B08: ctx.cache is private per principal the models run with', async () => {
    const seen: Record<string, Map<string, unknown>> = {};
    const m = new StaticModel('m', {
      vote: (req: DecisionRequest, ctx: EvaluationContext) => {
        seen[req.principal.id] = ctx.cache;
        return pass('m', TRUE);
      },
    });
    const { a } = setup([m]);
    const scope = { cache: new Map<string, unknown>() };
    await a.check({ principal: token(bob), permission: 'doc:read' }, scope);
    expect(seen.t1).to.be.instanceOf(Map);
    expect(seen.bob).to.be.instanceOf(Map);
    expect(seen.t1).to.not.equal(seen.bob);
    await a.check({ principal: bob, permission: 'doc:read' }, scope);
    const again = seen.bob;
    await a.check({ principal: token(bob), permission: 'doc:read' }, scope);
    expect(seen.bob).to.equal(again);
  });

  it('B08: a principal with no canonical state gets a map of its own object, never one keyed by type:id', async () => {
    const seen: Map<string, unknown>[] = [];
    const m = new StaticModel('m', {
      vote: (_req: DecisionRequest, ctx: EvaluationContext) => {
        seen.push(ctx.cache);
        return pass('m', TRUE);
      },
    });
    const { a } = setup([m]);
    const scope = { cache: new Map<string, unknown>() };
    const odd = principal('user', 'bob', { attributes: { live: new Map() } });
    await a.check({ principal: odd, permission: 'doc:read' }, scope);
    await a.check({ principal: odd, permission: 'doc:read' }, scope);
    await a.check({ principal: principal('user', 'bob', { attributes: { live: new Map() } }), permission: 'doc:read' }, scope);
    await a.check({ principal: bob, permission: 'doc:read' }, scope);
    expect(seen[0]).to.equal(seen[1]);
    expect(seen[2]).to.not.equal(seen[0]);
    expect(seen[3]).to.not.equal(seen[0]);
    expect(seen[3]).to.not.equal(seen[2]);
  });

  it('B08: preload walks the whole chain', async () => {
    const m = new StaticModel('m');
    const carol = principal('user', 'carol');
    const b = principal('user', 'bob', { onBehalfOf: carol });
    const t = token(b);
    await setup([m]).a.preload(t);
    expect(m.preloads).to.deep.equal([t, b, carol]);
  });
});

async function expectReject(p: Promise<unknown>, type: new (...args: never[]) => Error): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).to.be.instanceOf(type);
    return;
  }
  expect.fail('expected a rejection');
}
