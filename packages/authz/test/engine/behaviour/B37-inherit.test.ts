import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../../src/engine/authorizer.js';
import { FALSE, TRUE, and } from '../../../src/index.js';
import type { Ceiling, DecisionRequest, EvaluationContext, Principal, ResourceFilter, Vote } from '../../../src/index.js';
import { FakeAdapter, FakeRelation, FakeRow, RecordingAudit, StaticModel, fakeClock, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([
  { name: 'doc:read', types: ['doc'] },
  { name: 'doc:write', types: ['doc'] },
]);
const cmp = (field: string, value: string): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value });
const owner: ResourceFilter = { op: 'relation', relation: 'owner' };
const pass = (model: string, permitWhen: ResourceFilter, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen, denyWhen: FALSE, cacheable: true, ...extra });

const byId = (grants: Readonly<Record<string, ResourceFilter | undefined>>, name = 'm', options: { principalTypes?: string[] } = {}) =>
  new StaticModel(name, {
    ...(options.principalTypes ? { capabilities: { principalTypes: options.principalTypes } } : {}),
    vote: (req: DecisionRequest) => {
      const when = grants[req.principal.id];
      return when ? pass(name, when) : pass(name, FALSE, { reason: { code: 'role_too_low' } });
    },
  });

const rows = [new FakeRow('doc', 'd1', { owner: 'bob' }), new FakeRow('doc', 'd2', { owner: 'bot' })];

const setup = (models: StaticModel[], options: Partial<AuthorizerOptions> = {}) => {
  const audit = new RecordingAudit();
  const relation = new FakeRelation('doc', 'owner', (p, _ref, subject) => (subject as FakeRow).owner === p.id);
  const a = new Authorizer({ domain: 'root', registry, models, adapters: [new FakeAdapter(['doc'], { rows, relations: [relation] })], audit, clock: fakeClock().clock, ...options });
  return { a, audit, relation };
};

const bob = principal('user', 'bob', { ceiling: { roles: ['editor', 'viewer'] } });
const agent = (extra: Partial<Principal> = {}, delegate: Principal = bob): Principal => principal('agent', 'bot', { onBehalfOf: delegate, delegation: 'inherit', ...extra });

describe('B37: inherit delegation (agents)', () => {
  it('B37: the models run once with the delegate as principal and the agent as actor; the decision carries both refs', async () => {
    const seen: DecisionRequest[] = [];
    const m = new StaticModel('m', {
      vote: (req: DecisionRequest) => {
        seen.push(req);
        return pass('m', TRUE);
      },
    });
    const bot = agent();
    const d = await setup([m]).a.check({ principal: bot, permission: 'doc:read' });
    expect(d.allowed).to.equal(true);
    expect(d.principal).to.deep.equal({ type: 'user', id: 'bob' });
    expect(d.actor).to.deep.equal({ type: 'agent', id: 'bot' });
    expect(seen).to.have.length(1);
    expect(seen[0].principal).to.include({ type: 'user', id: 'bob' });
    expect(Object.isFrozen(seen[0].principal)).to.equal(true);
    expect(seen[0].actor).to.equal(bot);
  });

  it("B37: the agent's own assignments are never consulted", async () => {
    const { a } = setup([byId({ bot: TRUE })]);
    const d = await a.check({ principal: agent(), permission: 'doc:read' });
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'role_too_low', model: 'm' });
  });

  it('B37: an explicit input actor wins over the agent', async () => {
    const other = principal('service', 'svc');
    const d = await setup([byId({ bob: TRUE })]).a.check({ principal: agent(), actor: other, permission: 'doc:read' });
    expect(d.actor).to.deep.equal({ type: 'service', id: 'svc' });
  });

  it('B37: models filter by the type of the delegate (principalTypes)', async () => {
    const userOnly = byId({ bob: TRUE }, 'rbac', { principalTypes: ['user'] });
    const d = await setup([userOnly]).a.check({ principal: agent(), permission: 'doc:read' });
    expect(d.allowed).to.equal(true);
    expect(userOnly.calls).to.have.length(1);
  });

  it("B37: the agent's ceiling applies (out_of_scope) and so does the delegate's", async () => {
    const { a } = setup([byId({ bob: TRUE })]);
    const scoped = agent({ ceiling: { permissions: ['doc:read'], reason: 'out_of_scope' } });
    expect((await a.check({ principal: scoped, permission: 'doc:read' })).allowed).to.equal(true);
    expect((await a.check({ principal: scoped, permission: 'doc:write' })).reason).to.deep.equal({ code: 'out_of_scope', priority: 200 });
    const capped = agent({}, principal('user', 'bob', { ceiling: { permissions: ['doc:write'] } }));
    expect((await a.check({ principal: capped, permission: 'doc:read' })).reason).to.deep.equal({ code: 'ceiling', priority: 200 });
    const restricted = agent({ ceiling: { resources: [{ type: 'doc', id: 'd1' }] } });
    expect((await a.check({ principal: restricted, permission: 'doc:read', resource: { type: 'doc', id: 'd2' } })).allowed).to.equal(false);
    expect((await a.check({ principal: restricted, permission: 'doc:read' })).residual).to.deep.equal({ op: 'under', scopes: [{ type: 'doc', id: 'd1' }] });
  });

  it("B37: the delegate seen by the models has ceiling.roles = its own ∩ the agent's", async () => {
    const roles: (readonly string[] | undefined)[] = [];
    const m = new StaticModel('m', {
      vote: (req: DecisionRequest) => {
        roles.push(req.principal.ceiling?.roles);
        return pass('m', TRUE);
      },
    });
    const { a } = setup([m]);
    await a.check({ principal: agent({ ceiling: { roles: ['viewer', 'admin'] } }), permission: 'doc:read' });
    await a.check({ principal: agent(), permission: 'doc:read' });
    expect(roles).to.deep.equal([['viewer'], ['editor', 'viewer']]);
  });

  it('B37: relation ops in the residual are kept and refer to Decision.principal (the delegate)', async () => {
    const { a, relation } = setup([byId({ bob: owner })]);
    const d = await a.check({ principal: agent(), permission: 'doc:read' });
    expect(d.residual).to.deep.equal(owner);
    expect(d.principal).to.deep.equal({ type: 'user', id: 'bob' });
    expect((await a.check({ principal: agent(), permission: 'doc:read', resource: rows[0] })).allowed).to.equal(true);
    expect((await a.check({ principal: agent(), permission: 'doc:read', resource: rows[1] })).allowed).to.equal(false);
    expect(relation.calls.every((c) => c.principal.id === 'bob')).to.equal(true);
  });

  it('B37: inherit then intersect: the models run as the delegate and its own delegate must allow too', async () => {
    const carol = principal('user', 'carol');
    const chained = agent({}, principal('user', 'bob', { onBehalfOf: carol }));
    const { a } = setup([byId({ bob: cmp('team', 'red'), carol: cmp('state', 'open') })]);
    const d = await a.check({ principal: chained, permission: 'doc:read' });
    expect(d.residual).to.deep.equal(and(cmp('team', 'red'), cmp('state', 'open')));
    expect(d.principal).to.deep.equal({ type: 'user', id: 'bob' });
    const denied = await setup([byId({ bob: TRUE })]).a.check({ principal: chained, permission: 'doc:read' });
    expect(denied.reason).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'user:carol' });
  });

  it('B37: a forbidden delegate denies without consulting any model (not even for the agent)', async () => {
    const m = byId({ bot: TRUE });
    const d = await setup([m]).a.check({ principal: agent({}, principal('system', 'system')), permission: 'doc:read' });
    expect(d.reason).to.deep.equal({ code: 'delegate', priority: 200, delegate: 'system:system' });
    expect(m.calls).to.have.length(0);
  });

  it('B37: the audit names the agent (the request principal)', async () => {
    const { a, audit } = setup([byId({})]);
    await a.check({ principal: agent(), permission: 'doc:read' });
    expect(audit.entries).to.deep.equal([{ kind: 'deny', principal: { type: 'agent', id: 'bot' }, permission: 'doc:read', resource: { type: 'doc' }, reason: 'role_too_low' }]);
  });

  it("B37: ctx.cache is keyed by the full state of the delegate the models run with, so a narrowed copy never shares the delegate's map", async () => {
    const seen: unknown[] = [];
    const m = new StaticModel('m', {
      vote: (req: DecisionRequest, ctx: EvaluationContext) => {
        if (req.actor) seen.push(ctx.cache.get('warm'));
        else ctx.cache.set('warm', req.principal.id);
        return pass('m', TRUE);
      },
    });
    const { a } = setup([m]);
    const scope = { cache: new Map<string, unknown>() };
    await a.check({ principal: bob, permission: 'doc:read' }, scope);
    await a.check({ principal: agent({ ceiling: { roles: ['viewer'] } }), permission: 'doc:read' }, scope);
    // Not narrowed: the copy holds exactly bob's authority.
    await a.check({ principal: agent(), permission: 'doc:read' }, scope);
    await a.check({ principal: principal('user', 'carol'), actor: principal('agent', 'x'), permission: 'doc:read' }, scope);
    expect(seen).to.deep.equal([undefined, 'bob', undefined]);
  });

  it("B37: a memo of bob's live roles never widens a narrowed agent in the same scope (review probe P1)", async () => {
    // RBAC-like: steps 1-4 (held roles filtered by ceiling.roles) memoised per resource in ctx.cache.
    const rbacLike = () =>
      new StaticModel('rbac', {
        vote: (req: DecisionRequest, ctx: EvaluationContext) => {
          const key = `live:${req.resource.type}:${req.resource.id ?? ''}`;
          let live = ctx.cache.get(key) as string[] | undefined;
          if (!live) {
            const held = req.principal.id === 'bob' ? ['editor', 'viewer'] : [];
            const cap = req.principal.ceiling?.roles;
            live = cap ? held.filter((r) => cap.includes(r)) : held;
            ctx.cache.set(key, live);
          }
          return pass('rbac', (req.permission === 'doc:write' ? live.includes('editor') : live.length > 0) ? TRUE : FALSE);
        },
      });
    const plainBob = principal('user', 'bob');
    const viewerBot = agent({ ceiling: { roles: ['viewer'] } }, plainBob);
    const d1 = { type: 'doc', id: 'd1' };
    expect((await setup([rbacLike()]).a.check({ principal: viewerBot, permission: 'doc:write', resource: d1 })).allowed).to.equal(false);
    const { a } = setup([rbacLike()]);
    const scope = { cache: new Map<string, unknown>() };
    expect((await a.check({ principal: plainBob, permission: 'doc:read', resource: d1 }, scope)).allowed).to.equal(true);
    expect((await a.check({ principal: viewerBot, permission: 'doc:write', resource: d1 }, scope)).allowed).to.equal(false);
    expect((await a.check({ principal: viewerBot, permission: 'doc:read', resource: d1 }, scope)).allowed).to.equal(true);
    expect((await a.check({ principal: plainBob, permission: 'doc:write', resource: d1 }, scope)).allowed).to.equal(true);
  });

  it('B37: preload warms the narrowed delegate the models run with, never the agent itself', async () => {
    class Preloading extends StaticModel {
      async preload(p: Principal, ctx?: EvaluationContext): Promise<void> {
        this.preloads.push(p);
        ctx!.cache.set('roles', p.ceiling?.roles);
      }
    }
    const read: unknown[] = [];
    const m = new Preloading('m', {
      vote: (_req: DecisionRequest, ctx: EvaluationContext) => {
        read.push(ctx.cache.get('roles'));
        return pass('m', TRUE);
      },
    });
    const { a } = setup([m]);
    const scope = { cache: new Map<string, unknown>() };
    const bot = agent({ ceiling: { roles: ['viewer'] } });
    await a.preload(bot, scope);
    expect(m.preloads).to.have.length(1);
    expect(m.preloads[0]).to.include({ type: 'user', id: 'bob' });
    expect(m.preloads[0].ceiling?.roles).to.deep.equal(['viewer']);
    await a.check({ principal: bot, permission: 'doc:read' }, scope);
    await a.check({ principal: bob, permission: 'doc:read' }, scope);
    expect(read).to.deep.equal([['viewer'], undefined]);
  });

  it('B37: an unknown resource names the delegate and the agent, as the models path does', async () => {
    const m = byId({ bob: TRUE });
    const d = await setup([m]).a.check({ principal: agent(), permission: 'doc:read', resource: { type: 'doc', id: 'nope' } });
    expect(d.reason).to.deep.equal({ code: 'unknown_resource' });
    expect(d.principal).to.deep.equal({ type: 'user', id: 'bob' });
    expect(d.actor).to.deep.equal({ type: 'agent', id: 'bot' });
    expect(m.calls).to.have.length(0);
  });

  it("B37: the answer never exceeds the delegate's (fast-check)", async function () {
    this.timeout(60000);
    const grantArb = fc.constantFrom<ResourceFilter | undefined>(undefined, TRUE, cmp('team', 'red'), owner);
    const ceilingArb = fc.option(fc.record({ permissions: fc.subarray(['doc:read', 'doc:write']), roles: fc.subarray(['viewer', 'editor']) }, { requiredKeys: [] }), { nil: undefined }) as fc.Arbitrary<Ceiling | undefined>;
    await fc.assert(
      fc.asyncProperty(grantArb, grantArb, grantArb, ceilingArb, fc.constantFrom('doc:read', 'doc:write'), async (forBob, forBot, otherForBot, ceiling, permission) => {
        const run = async (grantForBot: ResourceFilter | undefined) => {
          const { a } = setup([byId({ bob: forBob, bot: grantForBot })]);
          const bobD = await a.check({ principal: principal('user', 'bob'), permission });
          const agentD = await a.check({ principal: agent(ceiling ? { ceiling } : {}, principal('user', 'bob')), permission });
          return { bobD, agentD };
        };
        const { bobD, agentD } = await run(forBot);
        // The agent's ceiling either denies or changes nothing (byId ignores roles), so an allowed agent gets bob's exact residual.
        if (agentD.allowed) {
          expect(bobD.allowed).to.equal(true);
          expect(agentD.residual).to.deep.equal(bobD.residual);
        }
        const other = (await run(otherForBot)).agentD;
        expect({ allowed: other.allowed, residual: other.residual, reason: other.reason }).to.deep.equal({ allowed: agentD.allowed, residual: agentD.residual, reason: agentD.reason });
      }),
      { numRuns: 200 },
    );
  });
});
