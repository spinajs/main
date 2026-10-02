import * as chai from 'chai';
import 'mocha';
import fc from 'fast-check';

import { Authorizer } from '../../../src/engine/authorizer.js';
import type { AuthorizerOptions } from '../../../src/engine/authorizer.js';
import { runAsync } from '../../../src/engine/run.js';
import { principalState } from '../../../src/engine/cache-key.js';
import { FALSE, ScopeAttributeStore, TRUE, and, not, or, resourceKey } from '../../../src/index.js';
import type { CheckInput, Decision, EvaluationContext, Principal, ResourceFilter, ResourceRef, Vote } from '../../../src/index.js';
import { FakeAdapter, FakeRelation, FakeRow, FakeScopeResolver, RecordingLog, StaticModel, deny, fakeClock, permit, principal, registryOf } from '../fakes.js';

const expect = chai.expect;

const registry = registryOf([{ name: 'doc:read', types: ['doc'] }]);
const ref = (r: string) => ({ ref: r });
const eq = (field: string, value: unknown): ResourceFilter => ({ op: 'cmp', field, cmp: 'eq', value } as ResourceFilter);
const pass = (model: string, permitWhen: ResourceFilter, extra: Partial<Vote> = {}): Vote => ({ model, permitWhen, denyWhen: FALSE, cacheable: true, ...extra });

const F1: ResourceRef = { type: 'folder', id: 'f1' };
const O1: ResourceRef = { type: 'org', id: 'o1' };
const O2: ResourceRef = { type: 'org', id: 'o2' };
const D1: ResourceRef = { type: 'doc', id: 'd1' };
const D2: ResourceRef = { type: 'doc', id: 'd2' };

// d1 -> folder f1 -> folder f2 -> org o1; d2 -> org o2 (the resolver answers null for o2).
const rows = () => [new FakeRow('doc', 'd1', { owner: 'bob', state: 'open' }, F1), new FakeRow('doc', 'd2', {}, O2), new FakeRow('doc', 'd3', { owner: 'bob', state: 'frozen' }, F1)];
const nodes = { 'folder:f1': { type: 'folder', id: 'f2' }, 'folder:f2': O1, 'org:o1': null, 'org:o2': null };
const folderAttributes = { 'folder:f1': { team: 'red' }, 'folder:f2': { team: 'blue', depth: 2 } };
const orgAttributes = { 'org:o1': { plan: 'pro', limits: { seats: 5 }, frozenState: 'frozen' }, 'org:o2': null };

const schemas = [
  { scopeType: 'org', schema: {}, defaults: { plan: 'free', public_links: true, limits: { seats: 1, storage: 10 } } },
  { scopeType: '$global', schema: {}, defaults: { region: 'eu' } },
];

class FakeStore extends ScopeAttributeStore {
  readonly calls: string[] = [];
  getImpl?: (ref: ResourceRef) => Promise<Readonly<Record<string, unknown>>>;

  constructor(private readonly rows: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {}) {
    super();
  }

  get(r: ResourceRef): Promise<Readonly<Record<string, unknown>>> {
    this.calls.push(resourceKey(r));
    if (this.getImpl) return this.getImpl(r);
    return Promise.resolve(this.rows[resourceKey(r)] ?? {});
  }

  async version(): Promise<string> {
    return '1';
  }
}

const setup = (models: StaticModel[], options: Partial<AuthorizerOptions> & { store?: FakeStore; resolver?: FakeScopeResolver } = {}) => {
  const log = new RecordingLog();
  const adapter = new FakeAdapter(['doc', 'folder'], { rows: rows(), nodes, scopeAttributes: folderAttributes });
  const resolver = options.resolver ?? new FakeScopeResolver(['org'], { 'org:o1': null, 'org:o2': null }, orgAttributes);
  const store = options.store;
  const a = new Authorizer({ domain: 'root', registry, models, adapters: [adapter], scopeResolvers: [resolver], scopeAttributes: { schemas, ...(store ? { store } : {}) }, log, clock: fakeClock().clock, ...options });
  return { a, log, adapter, resolver, store };
};

const alice = principal('user', 'alice', { attributes: { team: 'red' } });
const read = (resource?: ResourceRef | object, extra: Partial<CheckInput> = {}): CheckInput => (resource === undefined ? { principal: alice, permission: 'doc:read', ...extra } : { principal: alice, permission: 'doc:read', resource, ...extra });

/** The pipeline's result with the step 10 flag (white-box). */
const pipelineOf = (a: Authorizer, input: CheckInput): Promise<{ readonly decision: Decision; readonly uncacheable: boolean }> => runAsync((a as any)['pipeline'](input, (a as any)['newRun'](false, undefined)));

const within = async <T>(ms: number, run: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  const out = await run();
  expect(Date.now() - started, `took more than ${ms} ms`).to.be.below(ms);
  return out;
};

/** Every { ref } object left anywhere in a filter. */
function refsLeft(v: unknown, out: string[] = []): string[] {
  if (v === null || typeof v !== 'object') return out;
  if (!Array.isArray(v) && Object.hasOwn(v, 'ref')) out.push(String((v as { ref: unknown }).ref));
  for (const x of Object.values(v as object)) refsLeft(x, out);
  return out;
}

function cmpsOf(f: ResourceFilter, out: ResourceFilter[] = []): ResourceFilter[] {
  if (f.op === 'cmp') out.push(f);
  else if (f.op === 'and' || f.op === 'or') for (const x of f.args) cmpsOf(x, out);
  else if (f.op === 'not') cmpsOf(f.arg, out);
  return out;
}

describe('B39: scope attributes and engine refs', () => {
  it('B39: scope.<type>.* reads the nearest ancestor of that type through the adapter', async () => {
    const { a, adapter } = setup([new StaticModel('m', { vote: permit(eq('team', ref('scope.folder.team'))) })]);
    expect((await a.check(read(D1))).residual).to.deep.equal(eq('team', 'red'));
    expect(adapter.attributeCalls.map(resourceKey)).to.deep.equal(['folder:f1']);
    // The step 5 list is reused: one ancestors call per check.
    expect(adapter.ancestorCalls).to.have.length(1);
    // f1 has no depth; f2's never shows through the nearest folder.
    const depth = setup([new StaticModel('m', { vote: permit(eq('depth', ref('scope.folder.depth'))) })]);
    expect((await depth.a.check(read(D1))).residual).to.equal(FALSE);
  });

  it('B39: scope.<type>.* reads through the scope resolver, over the schema defaults (deep merge)', async () => {
    const { a, resolver } = setup([new StaticModel('m', { vote: permit(and(eq('plan', ref('scope.org.plan')), eq('seats', ref('scope.org.limits.seats')), eq('storage', ref('scope.org.limits.storage')))) })]);
    const d = await a.check(read(D1));
    expect(d.residual).to.deep.equal(and(eq('plan', 'pro'), eq('seats', 5), eq('storage', 10)));
    expect(resolver.attributeCalls.map(resourceKey)).to.deep.equal(['org:o1']);
  });

  it('B39: the store wins over the defaults and the resolver; ctx.attributes sees the same frozen merge', async () => {
    const store = new FakeStore({ 'org:o1': { plan: 'enterprise', limits: { seats: 50 } } });
    let seen: unknown;
    const m = new StaticModel('m', {
      vote: async (_req, ctx) => {
        seen = await ctx.attributes(O1);
        return pass('m', and(eq('plan', ref('scope.org.plan')), eq('seats', ref('scope.org.limits.seats')), eq('links', ref('scope.org.public_links'))));
      },
    });
    const { a } = setup([m], { store });
    const d = await a.check(read(D1));
    expect(seen).to.deep.equal({ plan: 'enterprise', public_links: true, limits: { seats: 50, storage: 10 }, frozenState: 'frozen' });
    expect(Object.isFrozen(seen) && Object.isFrozen((seen as { limits: object }).limits)).to.equal(true);
    expect(d.residual).to.deep.equal(and(eq('plan', 'enterprise'), eq('seats', 50), eq('links', true)));
    // One load per node per request, shared by the model and the binder.
    expect(store.calls).to.deep.equal(['org:o1']);
  });

  it('B39: a type with neither adapter nor resolver gets defaults ⊕ store', async () => {
    const store = new FakeStore({ 'team:t1': { size: 3 } });
    let seen: unknown;
    const m = new StaticModel('m', {
      vote: async (_req, ctx) => {
        seen = await ctx.attributes({ type: 'team', id: 't1' });
        return pass('m', TRUE);
      },
    });
    await setup([m], { store }).a.check(read());
    expect(seen).to.deep.equal({ size: 3 });
  });

  it('B39: a resolver answering null makes the node unknown: the vote reading it is indeterminate and the store is not read', async () => {
    const store = new FakeStore({ 'org:o2': { plan: 'enterprise' } });
    let seen: unknown = 'unset';
    const m = new StaticModel('m', {
      vote: async (_req, ctx) => {
        seen = await ctx.attributes(O2);
        return pass('m', eq('plan', ref('scope.org.plan')));
      },
    });
    const d = await setup([m], { store }).a.check(read(D2));
    expect(seen).to.equal(null);
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'model_error', model: 'm' });
    expect(store.calls).to.deep.equal([]);
  });

  it('B39: a scope ref that resolves missing makes the vote indeterminate, wherever the vote holds it (decision 29)', async () => {
    const missing = eq('x', ref('scope.org.nope'));
    const cases: [string, ResourceFilter, string][] = [
      ['missing', missing, 'scope.org.nope'],
      ['not(missing)', not(missing), 'scope.org.nope'],
      ['an object is not a literal', eq('x', ref('scope.org.limits')), 'scope.org.limits'],
      ['unsafe path', eq('x', ref('scope.org.__proto__.x')), 'scope.org.__proto__.x'],
      ['type not among the ancestors', eq('x', ref('scope.team.x')), 'scope.team.x'],
      ['bare scope', eq('x', ref('scope.org')), 'scope.org'],
      ['next to a known value', or(eq('a', 1), missing), 'scope.org.nope'],
    ];
    for (const [name, when, missingRef] of cases) {
      const { a, log } = setup([new StaticModel('m', { vote: permit(when) })]);
      const d = await a.explain(read(D1));
      expect(d.residual, name).to.equal(FALSE);
      expect(d.reason, name).to.deep.equal({ code: 'model_error', model: 'm' });
      expect(d.trace!.votes[0].error, name).to.include(missingRef);
      expect(
        log.at('error').some((e) => /"m"/.test(e.message) && e.message.includes(missingRef)),
        name,
      ).to.equal(true);
    }
    // In denyWhen and in a deny entry too.
    const inDeny = await setup([new StaticModel('m', { vote: { ...permit(), ...deny(missing) } })]).a.check(read(D1));
    expect(inDeny.reason).to.deep.equal({ code: 'model_error', model: 'm' });
    const inEntry = await setup([new StaticModel('m', { vote: pass('m', TRUE, { denies: [{ when: missing, reason: { code: 'frozen', priority: 100 } }] }) })]).a.check(read(D1));
    expect(inEntry.allowed).to.equal(false);
    expect(inEntry.reason).to.deep.equal({ code: 'model_error', model: 'm' });
    // Under deny-overrides another model's permit does not outweigh it.
    const two = await setup([new StaticModel('m', { vote: permit(missing) }), new StaticModel('n', { vote: permit() })]).a.check(read(D1));
    expect(two.reason).to.deep.equal({ code: 'model_error', model: 'm' });
    // Refs outside scope.* keep the polarity rule.
    for (const when of [eq('x', ref('foo.bar')), eq('x', ref('actor.attributes.nope'))]) {
      const d = await setup([new StaticModel('m', { vote: permit(or(eq('a', 1), when)) })]).a.check(read(D1));
      expect(d.residual).to.deep.equal(eq('a', 1));
    }
  });

  it('B39: under permit-overrides an indeterminate vote is skipped and the next model decides; explain agrees (decision 29)', async () => {
    const models = () => [new StaticModel('m', { vote: pass('m', TRUE, { denies: [{ when: eq('x', ref('scope.org.nope')), reason: { code: 'frozen', priority: 100 } }] }) }), new StaticModel('n', { vote: permit(eq('b', 2)) })];
    const { a } = setup(models(), { combine: { default: { algorithm: 'permit-overrides' } } });
    const checked = await a.check(read(D1));
    const explained = await a.explain(read(D1));
    expect(checked.residual).to.deep.equal(eq('b', 2));
    expect(explained.residual).to.deep.equal(checked.residual);
    expect(explained.trace!.votes.map((v) => v.error !== undefined)).to.deep.equal([true, false]);
  });

  it('B39: a model whose condition reads a missing attribute is indeterminate (B04)', async () => {
    const strict = (target: ResourceRef) =>
      new StaticModel('abac', {
        vote: async (_req, ctx) => {
          const attrs = await ctx.attributes(target);
          if (attrs === null || !Object.hasOwn(attrs, 'agents')) throw new Error('scope attribute agents is missing');
          return pass('abac', TRUE);
        },
      });
    const unknownNode = await setup([strict(O2)]).a.check(read(D2));
    expect(unknownNode.reason).to.deep.equal({ code: 'model_error', model: 'abac' });
    const missingKey = await setup([strict(O1)]).a.check(read(D1));
    expect(missingKey.reason).to.deep.equal({ code: 'model_error', model: 'abac' });
  });

  it('B39: a failing store makes the asking model and every vote reading that node indeterminate', async () => {
    const failing = () => {
      const store = new FakeStore();
      store.getImpl = () => Promise.reject(new Error('store down'));
      return store;
    };
    const asks = new StaticModel('asks', {
      vote: async (_req, ctx) => {
        await ctx.attributes(O1);
        return pass('asks', TRUE);
      },
    });
    expect((await setup([asks], { store: failing() }).a.check(read(D1))).reason).to.deep.equal({ code: 'model_error', model: 'asks' });

    const { a, log } = setup([new StaticModel('m', { vote: permit(or(eq('a', 1), eq('plan', ref('scope.org.plan')))) })], { store: failing() });
    const d = await a.check(read(D1));
    expect(d.residual).to.equal(FALSE);
    expect(d.reason).to.deep.equal({ code: 'model_error', model: 'm' });
    const denied = await setup([new StaticModel('m', { vote: permit(eq('plan', ref('scope.org.plan'))) })], { store: failing() }).a.check(read(D1));
    expect(denied.reason).to.deep.equal({ code: 'model_error', model: 'm' });
    expect(log.at('error').some((e) => /org:o1/.test(e.message) && /store down/.test(e.message))).to.equal(true);
  });

  it('B39: a store answering a non-object fails the load (no default shows through)', async () => {
    const store = new FakeStore();
    store.getImpl = () => Promise.resolve(null as never);
    const d = await setup([new StaticModel('m', { vote: permit(eq('plan', ref('scope.org.public_links'))) })], { store }).a.check(read(D1));
    expect(d.allowed).to.equal(false);
    expect(d.reason).to.deep.equal({ code: 'model_error', model: 'm' });
  });

  it('B39: a store load that never settles times out to unknown: the vote reading it is indeterminate', async () => {
    const store = new FakeStore();
    store.getImpl = () => new Promise(() => undefined);
    let ctx!: EvaluationContext;
    const m = new StaticModel('m', {
      vote: (_req, c) => {
        ctx = c;
        return pass('m', or(eq('a', 1), eq('plan', ref('scope.org.plan'))));
      },
    });
    const { a, log } = setup([m], { store, config: { modelTimeoutMs: 50 } });
    const d = await within(1000, () => a.check(read(D1)));
    expect(d.residual).to.equal(FALSE);
    expect(d.reason).to.deep.equal({ code: 'model_error', model: 'm' });
    expect(log.at('error').some((e) => /org:o1/.test(e.message) && /timed out/.test(e.message))).to.equal(true);
    // The memoised load answers null (unknown) to models too.
    expect(await within(1000, () => ctx.attributes(O1))).to.equal(null);

    const only = setup([new StaticModel('m', { vote: permit(eq('plan', ref('scope.org.plan'))) })], { store, config: { modelTimeoutMs: 50 } });
    const denied = await within(1000, () => only.a.check(read(D1)));
    expect(denied.allowed).to.equal(false);
    expect(denied.reason).to.deep.equal({ code: 'model_error', model: 'm' });
  });

  it('B39: an adapter scopeAttributes that never settles times out to unknown: the vote reading it is indeterminate', async () => {
    const m = new StaticModel('m', { vote: permit(or(eq('a', 1), eq('team', ref('scope.folder.team')))) });
    const { a, adapter } = setup([m], { config: { modelTimeoutMs: 50 } });
    adapter.scopeAttributes = () => new Promise(() => undefined);
    const d = await within(1000, () => a.check(read(D1)));
    expect(d.residual).to.equal(FALSE);
    expect(d.reason).to.deep.equal({ code: 'model_error', model: 'm' });
  });

  it('B39: actor.* reads input.actor, else the inherit agent, else the principal the models ran with', async () => {
    const team = permit(eq('team', ref('actor.attributes.team')));
    const { a } = setup([new StaticModel('m', { vote: team })]);
    expect((await a.check(read())).residual).to.deep.equal(eq('team', 'red'));
    const bot = principal('service', 'bot', { attributes: { team: 'blue' } });
    expect((await a.check(read(undefined, { actor: bot }))).residual).to.deep.equal(eq('team', 'blue'));
    const bob = principal('user', 'bob', { attributes: { team: 'bob-team' } });
    const agent = principal('agent', 'ai', { onBehalfOf: bob, delegation: 'inherit', attributes: { team: 'green' } });
    const inherit = await a.check({ principal: agent, permission: 'doc:read' });
    expect(inherit.principal).to.deep.equal({ type: 'user', id: 'bob' });
    expect(inherit.residual).to.deep.equal(eq('team', 'green'));
    // No IO for actor refs: filterNow answers.
    expect(a.filterNow(alice, 'doc:read', 'doc')).to.deep.equal(eq('team', 'red'));
    const nope = setup([new StaticModel('m', { vote: permit(eq('team', ref('actor.attributes.nope'))) })]);
    expect((await nope.a.check(read())).residual).to.equal(FALSE);
  });

  it('B39: type-level refs: scope.<type> is missing (vote indeterminate), scope.$global binds from defaults ⊕ store', async () => {
    const both = permit(or(eq('plan', ref('scope.org.plan')), eq('region', ref('scope.$global.region'))));
    const typed = setup([new StaticModel('m', { vote: both })]);
    expect((await typed.a.check(read())).reason).to.deep.equal({ code: 'model_error', model: 'm' });
    expect(await typed.a.filter(alice, 'doc:read', 'doc')).to.equal(FALSE);
    // No load starts for a type-level scope ref, so filterNow answers without IO.
    expect(setup([new StaticModel('m', { vote: permit(eq('plan', ref('scope.org.plan'))) })]).a.filterNow(alice, 'doc:read', 'doc')).to.equal(FALSE);
    expect(typed.resolver.attributeCalls).to.deep.equal([]);

    const vote = permit(eq('region', ref('scope.$global.region')));
    const { a } = setup([new StaticModel('m', { vote })]);
    expect((await a.check(read())).residual).to.deep.equal(eq('region', 'eu'));
    expect(await a.filter(alice, 'doc:read', 'doc')).to.deep.equal(eq('region', 'eu'));

    // A $global ref needs a load, so filterNow cannot answer, and it starts none.
    const store = new FakeStore({ $global: { region: 'us' } });
    const sync = setup([new StaticModel('m', { vote })], { store });
    expect(sync.a.filterNow(alice, 'doc:read', 'doc')).to.equal(undefined);
    await new Promise((r) => setTimeout(r, 10));
    expect(store.calls).to.deep.equal([]);
    expect(sync.resolver.attributeCalls).to.deep.equal([]);
    expect(sync.adapter.attributeCalls).to.deep.equal([]);

    expect((await setup([new StaticModel('m', { vote })], { store }).a.check(read())).residual).to.deep.equal(eq('region', 'us'));
    // On a ref with an id, $global resolves too.
    expect((await setup([new StaticModel('m', { vote: permit(eq('region', ref('scope.$global.region'))) })], { store }).a.check(read(D1))).residual).to.deep.equal(eq('region', 'us'));
  });

  it('B39: the reason pass loads and binds the deny entries with the same attributes', async () => {
    const vote = pass('m', eq('owner', ref('principal.id')), { reason: { code: 'not_owner', priority: 300 }, denies: [{ when: eq('state', ref('scope.org.frozenState')), reason: { code: 'frozen', priority: 100 } }] });
    const { a } = setup([new StaticModel('m', { vote })]);
    const [d1, d3] = rows().filter((r) => r.id !== 'd2');
    // d1 is open: the deny entry does not hold once scope.org.frozenState is known.
    expect((await a.check(read(d1))).reason).to.deep.equal({ code: 'not_owner', priority: 300, model: 'm' });
    expect((await a.check(read(d3))).reason).to.deep.equal({ code: 'frozen', priority: 100, model: 'm' });
  });

  it("B39: an intersect delegate's residual binds its actor and scope refs for the delegate", async () => {
    const bob = principal('user', 'bob');
    const m = new StaticModel('m', { vote: (req) => pass('m', and(eq(`who_${req.principal.id}`, ref('actor.id')), eq('team', ref('scope.folder.team')))) });
    const { a } = setup([m]);
    const d = await a.check({ principal: principal('token', 't1', { onBehalfOf: bob }), permission: 'doc:read', resource: D1 });
    expect(d.allowed).to.equal(true);
    expect(refsLeft(d.residual)).to.deep.equal([]);
    expect(cmpsOf(d.residual)).to.deep.include.members([eq('who_t1', 't1'), eq('who_bob', 'bob'), eq('team', 'red')]);
  });

  it('B39: only refs whose path the L2 key holds keep a decision cacheable (decision 17, step 10 hook)', async () => {
    const run = async (when: ResourceFilter, p: Principal = alice) => {
      const { a } = setup([new StaticModel('n', { vote: permit(when) })]);
      const result = await pipelineOf(a, { principal: p, permission: 'doc:read', resource: D1, env: { x: 'y' } });
      return result.uncacheable;
    };
    expect(await run(eq('a', 1))).to.equal(false);
    const safe = ['principal.type', 'principal.id', 'actor.authenticated', 'principal.source', 'principal.delegation', 'principal.attributes', 'principal.attributes.team', 'actor.attributes.team.x', 'principal.ceiling', 'principal.ceiling.reason', 'principal.ceiling.roles', 'principal.ceiling.expiresAt', 'principal.authn.method', 'principal.authn.strategy', 'principal.authn.assurance', 'principal.authn.mfa', 'actor.authn.authenticatedAt', 'principal.authn.sessionHandle', 'principal.authn.impersonator.type', 'actor.authn.impersonator.id', 'scope.org.plan', 'scope.$global.region'];
    for (const r of safe) expect(await run(eq('a', ref(r))), r).to.equal(false);
    const unsafe = [
      'env.x',
      'principal.identity.sub',
      'actor.identity.sub',
      'principal.onBehalfOf.id',
      'principal.onBehalfOf.identity.sub',
      'actor.onBehalfOf.identity.sub',
      'principal.companions.0.id',
      'principal.companions.0.attributes.team',
      'principal.authn.impersonator.attributes.team',
      'principal.authn.impersonator.identity.sub',
      'principal.authn.impersonator',
      'principal.authn.mfa.0',
      'principal.authn.other',
      // The key holds these ceiling lists as sorted sets, not their order.
      'principal.ceiling.roles.0',
      'principal.ceiling.resources.0.id',
      'principal.type.length',
      'principal.nope',
      'principal',
      'actor',
      'foo.bar',
    ];
    for (const r of unsafe) expect(await run(eq('a', ref(r))), r).to.equal(true);
    // Read before binding: a denial bound from an env ref is flagged too.
    expect(await run(not(eq('a', ref('env.nope'))))).to.equal(true);
    // A ref the combination simplified away was never read.
    expect(await run(or(TRUE, eq('a', ref('env.x'))))).to.equal(false);
    // Only bob's (the intersect delegate's) residual reads env or identity: the flag comes back from the nested check.
    const bobOnly = async (when: ResourceFilter) => {
      const { a } = setup([new StaticModel('m', { vote: (req) => pass('m', req.principal.id === 'bob' ? when : TRUE) })]);
      const result = await pipelineOf(a, { principal: principal('token', 't1', { onBehalfOf: principal('user', 'bob') }), permission: 'doc:read', env: { x: 'y' } });
      return result.uncacheable;
    };
    expect(await bobOnly(eq('a', ref('env.x')))).to.equal(true);
    expect(await bobOnly(eq('a', ref('principal.identity.sub')))).to.equal(true);
    expect(await bobOnly(eq('a', ref('principal.attributes.team')))).to.equal(false);
  });

  it('B39: identity read through onBehalfOf, companions or the impersonator never binds into a cacheable residual (review probe P1)', async () => {
    const bob = (sub: string) => principal('user', 'bob', { identity: { sub } } as Partial<Principal>);
    const t1 = (sub: string) => principal('token', 't1', { onBehalfOf: bob(sub), delegation: 'intersect' } as Partial<Principal>);
    const { a } = setup([new StaticModel('m', { vote: (req) => pass('m', req.principal.id === 't1' ? eq('sub', ref('principal.onBehalfOf.identity.sub')) : TRUE) })]);
    const r1 = await pipelineOf(a, { principal: t1('x'), permission: 'doc:read' });
    const r2 = await pipelineOf(a, { principal: t1('y'), permission: 'doc:read' });
    // One L2 key, two residuals: neither may be stored.
    expect(principalState(t1('x'))).to.equal(principalState(t1('y')));
    expect(r1.decision.residual).to.deep.equal(eq('sub', 'x'));
    expect(r2.decision.residual).to.deep.equal(eq('sub', 'y'));
    expect([r1.uncacheable, r2.uncacheable]).to.deep.equal([true, true]);

    const agent = (sub: string) => principal('agent', 'ai', { onBehalfOf: bob(sub) } as Partial<Principal>);
    const viaActor = setup([new StaticModel('m', { vote: permit(eq('sub', ref('actor.onBehalfOf.identity.sub'))) })]);
    expect(principalState(agent('x'))).to.equal(principalState(agent('y')));
    expect((await pipelineOf(viaActor.a, { principal: alice, permission: 'doc:read', actor: agent('x') })).uncacheable).to.equal(true);

    const link = (team: string) => principal('link', 'l1', { companions: [{ type: 'user', id: 'u1', attributes: { team } } as unknown as Principal] });
    const viaCompanion = setup([new StaticModel('m', { vote: permit(eq('team', ref('principal.companions.0.attributes.team'))) })]);
    expect(principalState(link('red'))).to.equal(principalState(link('blue')));
    const companion = await pipelineOf(viaCompanion.a, { principal: link('red'), permission: 'doc:read' });
    expect(companion.decision.residual).to.deep.equal(eq('team', 'red'));
    expect(companion.uncacheable).to.equal(true);

    const impersonated = (team: string) => principal('user', 'alice', { authn: { method: 'password', impersonator: { type: 'user', id: 'admin', attributes: { team } } } } as unknown as Partial<Principal>);
    const viaImpersonator = setup([new StaticModel('m', { vote: permit(eq('team', ref('principal.authn.impersonator.attributes.team'))) })]);
    expect(principalState(impersonated('red'))).to.equal(principalState(impersonated('blue')));
    const imp = await pipelineOf(viaImpersonator.a, { principal: impersonated('red'), permission: 'doc:read' });
    expect(imp.decision.residual).to.deep.equal(eq('team', 'red'));
    expect(imp.uncacheable).to.equal(true);
  });

  it('B39: refs read only by the fields cover or the reason pass make the decision non-cacheable too', async () => {
    // The allow is or(TRUE, P2) = TRUE; only the fields cover sees P2.
    const fieldsOnly = setup([new StaticModel('m1', { vote: permit(TRUE) }), new StaticModel('m2', { vote: permit(eq('a', ref('principal.companions.0.id'))) })]);
    const f = await pipelineOf(fieldsOnly.a, { principal: principal('link', 'l1', { companions: [{ type: 'user', id: 'u1' } as unknown as Principal] }), permission: 'doc:read' });
    expect(f.decision.allowed).to.equal(true);
    expect(f.uncacheable).to.equal(true);

    // Denied against the subject: only the reason pass binds the deny entry.
    const vote = pass('m', eq('owner', 'nobody'), { reason: { code: 'not_owner', priority: 300 }, denies: [{ when: eq('sub', ref('principal.identity.sub')), reason: { code: 'mismatch', priority: 100 } }] });
    const reasons = setup([new StaticModel('m', { vote })]);
    const r = await pipelineOf(reasons.a, { principal: principal('user', 'alice', { identity: { sub: 'x' } } as Partial<Principal>), permission: 'doc:read', resource: rows()[0] });
    expect(r.decision.allowed).to.equal(false);
    expect(r.uncacheable).to.equal(true);
  });

  it('B39: a scope attribute load that rejects or times out in the binder makes the decision non-cacheable', async () => {
    const plan = permit(or(eq('a', 1), eq('plan', ref('scope.org.plan'))));
    const healthy = setup([new StaticModel('m', { vote: plan })], { store: new FakeStore() });
    expect((await pipelineOf(healthy.a, read(D1))).uncacheable).to.equal(false);
    // A null answer (the resolver's for o2) leaves the ref missing: the vote is indeterminate, so the decision is faulted (decisions 22, 29).
    expect((await pipelineOf(healthy.a, read(D2))).uncacheable).to.equal(true);

    const down = new FakeStore();
    down.getImpl = () => Promise.reject(new Error('store down'));
    const rejected = await pipelineOf(setup([new StaticModel('m', { vote: plan })], { store: down }).a, read(D1));
    expect(rejected.decision.residual).to.equal(FALSE);
    expect(rejected.uncacheable).to.equal(true);

    const hung = new FakeStore();
    hung.getImpl = () => new Promise(() => undefined);
    const h = setup([new StaticModel('m', { vote: plan })], { store: hung, config: { modelTimeoutMs: 50 } });
    const timedOut = await within(1000, () => pipelineOf(h.a, read(D1)));
    expect(timedOut.decision.residual).to.equal(FALSE);
    expect(timedOut.uncacheable).to.equal(true);
    // Logged once, although the store's own limit and the binder's both run out.
    await new Promise((r) => setTimeout(r, 40));
    expect(h.log.at('error').filter((e) => /org:o1/.test(e.message) && /timed out/.test(e.message))).to.have.length(1);
  });

  it('B39: a timeout memoised inside the load (a model asked first) still makes the decision non-cacheable', async () => {
    const hung = new FakeStore();
    hung.getImpl = () => new Promise(() => undefined);
    const m = new StaticModel('m', {
      vote: async (_req, ctx) => {
        // The load's own limit runs out before the binder starts waiting, so the binder reads a settled null.
        void ctx.attributes(O1).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 25));
        return pass('m', or(eq('a', 1), eq('plan', ref('scope.org.plan'))));
      },
    });
    const { a } = setup([m], { store: hung, config: { modelTimeoutMs: 50 } });
    const r = await within(1000, () => pipelineOf(a, read(D1)));
    expect(r.decision.residual).to.equal(FALSE);
    expect(r.uncacheable).to.equal(true);
  });

  it('B39: the reason pass waits one modelTimeoutMs in all', async () => {
    const stuck = new FakeRelation('doc', 'stuck', () => new Promise<boolean>(() => undefined));
    const stuckToo = new FakeRelation('doc', 'stuckToo', () => new Promise<boolean>(() => undefined));
    const vote = pass('m', eq('owner', 'nobody'), {
      reason: { code: 'not_owner', priority: 300 },
      denies: [
        { when: { op: 'relation', relation: 'stuckToo' } as ResourceFilter, reason: { code: 'plan', priority: 100 } },
        { when: { op: 'relation', relation: 'stuck' } as ResourceFilter, reason: { code: 'stuck', priority: 50 } },
      ],
    });
    const { a } = setup([new StaticModel('m', { vote })], { relations: [stuck, stuckToo], config: { modelTimeoutMs: 1000 } });
    const d = await within(1900, () => a.check(read(rows()[0])));
    expect(d.allowed).to.equal(false);
    // The batch ran out of time: static truths.
    expect(d.reason).to.deep.equal({ code: 'not_owner', priority: 300, model: 'm' });
  });

  it('B39: no ref survives binding, whatever refs the votes hold (fast-check)', async function () {
    this.timeout(60000);
    const refArb = fc.constantFrom('actor.id', 'actor.attributes.team', 'actor.identity.sub', 'principal.id', 'principal.nope', 'env.x', 'env.now', 'scope.folder.team', 'scope.folder.nope', 'scope.org.plan', 'scope.org.limits', 'scope.org.limits.seats', 'scope.$global.region', 'scope.team.x', 'scope', 'scope.org', 'foo.bar', 'actor');
    const leaf = fc.oneof(
      refArb.map((r) => eq('f', ref(r))),
      fc.constantFrom(TRUE, FALSE, eq('a', 1)),
    );
    const { tree } = fc.letrec<{ tree: ResourceFilter }>((tie) => ({
      tree: fc.oneof(
        { depthSize: 'small', withCrossShrink: true },
        leaf,
        fc.array(tie('tree'), { minLength: 1, maxLength: 3 }).map((args) => ({ op: 'and', args } as ResourceFilter)),
        fc.array(tie('tree'), { minLength: 1, maxLength: 3 }).map((args) => ({ op: 'or', args } as ResourceFilter)),
        tie('tree').map((arg) => ({ op: 'not', arg } as ResourceFilter)),
      ),
    }));
    const store = new FakeStore({ 'org:o1': { plan: 'enterprise' } });
    await fc.assert(
      fc.asyncProperty(tree, tree, fc.constantFrom<ResourceRef | undefined>(undefined, D1, D2), async (p, dn, resource) => {
        const { a } = setup([new StaticModel('m', { vote: { permitWhen: p, denyWhen: dn } })], { store });
        const d = await a.check(read(resource, { env: { x: 'y' } }));
        expect(refsLeft(d.residual)).to.deep.equal([]);
      }),
      { numRuns: 300 },
    );
  });
});
