import * as chai from 'chai';
import 'mocha';
import { Authorizer, AuthzConfigError, CONDITION_UNKNOWN, DefaultConditionCompiler, FALSE, GLOBAL, PermissionRegistryImpl, TRUE, UnknownPermission } from '@spinajs/authz';
import type { DecisionRequest, EvaluationContext, Policy, Principal, ResourceRef, Vote } from '@spinajs/authz';
import { FakeScopeResolver, agentPrincipal, fakeEvaluationContext, fakeModelInitContext, servicePrincipal, userPrincipal } from '@spinajs/authz-testing';

import { AbacModel, ConfigPolicyStore, MemoryPolicyStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-01T12:00:00.000Z');
const O1: ResourceRef = { type: 'org', id: 'o1' };
const O2: ResourceRef = { type: 'org', id: 'o2' };
const F1: ResourceRef = { type: 'file', id: 'f1' };
const F2: ResourceRef = { type: 'file', id: 'f2' };

const alice = userPrincipal('alice', { attributes: { dept: 'ops' } });
const svc = servicePrincipal('svc');
const agent = agentPrincipal('ag1', alice);

const registry = (): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'file:read', types: ['file', 'folder'], fields: true },
      { name: 'file:write', types: ['file', 'folder'] },
      { name: 'file:delete', types: ['file', 'folder'] },
    ],
    'test',
  );
  r.freeze();
  return r;
};

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['file:read'], source: 'test', ...extra });

async function modelWith(policies: readonly Policy[], stores?: ConstructorParameters<typeof AbacModel>[0]): Promise<AbacModel> {
  const m = new AbacModel(stores ?? { stores: [new MemoryPolicyStore(policies)] });
  await m.init(fakeModelInitContext({ permissions: registry(), config: { policies } }));
  return m;
}

const resolver = () =>
  new FakeScopeResolver({
    nodes: [
      { ref: F1, parent: O1 },
      { ref: F2, parent: O2 },
      { ref: O1, attributes: { policies: { open: true } } },
      { ref: O2, attributes: { policies: {} } },
    ],
  });

const ctxFor = (now = NOW): EvaluationContext => fakeEvaluationContext({ now, scopeResolvers: [resolver()], permissions: registry(), conditions: new DefaultConditionCompiler() });
const req = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({ principal: alice, permission: 'file:read', resource: F1, env: { now: NOW }, ...over });
const vote = async (m: AbacModel, over: Partial<DecisionRequest> = {}, ctx = ctxFor()): Promise<Vote> => m.evaluate(req(over), ctx);

describe('authz-abac: AbacModel', () => {
  describe('init and routing', () => {
    it('loads the configured policies through a ConfigPolicyStore by default', async () => {
      const m = new AbacModel();
      await m.init(fakeModelInitContext({ permissions: registry(), config: { policies: [{ id: 'p1', effect: 'permit', permissions: ['file:read'] }] } }));
      expect(m.name).to.equal('abac');
      expect(m.applies(registry().require('file:read'), 'file')).to.equal(true);
      expect(m.applies(registry().require('file:write'), 'file')).to.equal(false);
      expect(m.version()).to.match(/^[0-9a-f]{16}#0$/);
    });

    it('fails the boot on an unregistered permission (B02), a malformed policy or condition', async () => {
      const m = await modelWith([policy('p1', { permissions: ['ghost:read'] })]);
      expect(() => m.applies(registry().require('file:read'), 'file')).to.throw(UnknownPermission, /abac policy "p1".*ghost:read/);
      let error: unknown;
      await modelWith([{ ...policy('p2'), when: { fn: 'nope' } } as Policy]).catch((e) => (error = e));
      expect(error).to.be.instanceOf(AuthzConfigError);
      expect((error as Error).message).to.match(/abac policy "p2" when: unknown condition function "nope"/);
    });

    it('says sync always only for static, unconditional, unscoped policies', async () => {
      expect(new AbacModel().capabilities.sync).to.equal('never');
      const plain = new AbacModel();
      await plain.init(fakeModelInitContext({ permissions: registry(), config: { policies: [policy('p1')] } }));
      expect(plain.capabilities).to.deep.include({ sync: 'always', fields: true, needsSubject: true, effects: ['permit', 'deny'] });
      expect(plain.capabilities.residuals).to.include.members(['cmp', 'under', 'and', 'or', 'not', 'true', 'false']);
      const conditional = new AbacModel();
      await conditional.init(fakeModelInitContext({ permissions: registry(), config: { policies: [policy('p1', { when: { attr: 'resource.a', eq: 1 } })] } }));
      expect(conditional.capabilities.sync).to.equal('never');
      expect((await modelWith([policy('p1')])).capabilities.sync).to.equal('never'); // a memory store is not static
    });
  });

  describe('evaluate', () => {
    it('votes nothing when no policy targets the request', async () => {
      const v = await vote(await modelWith([policy('p1', { principalTypes: ['service'] })]));
      expect(v).to.deep.include({ model: 'abac', permitWhen: FALSE, denyWhen: FALSE, cacheable: true });
      expect(v.denies).to.equal(undefined);
    });

    it('ORs the permits and the denies, one denies entry per deny policy with its reason, priority and sortKey', async () => {
      const m = await modelWith([policy('read'), policy('blocked', { effect: 'deny', reason: 'blocked' }), policy('agents', { effect: 'deny', reason: 'agents_disabled', priority: 100 }), policy('plain-deny', { effect: 'deny' })]);
      const v = await vote(m);
      expect(v.permitWhen).to.equal(TRUE);
      expect(v.denyWhen).to.equal(TRUE);
      expect(v.denies?.map((d) => d.reason)).to.deep.equal([
        { code: 'blocked', policy: 'blocked', priority: 500, sortKey: 'blocked' },
        { code: 'agents_disabled', policy: 'agents', priority: 100, sortKey: 'agents' },
        { code: 'policy', policy: 'plain-deny', priority: 500, sortKey: 'plain-deny' },
      ]);
    });

    it('matches actor types against the agent under inherit', async () => {
      const m = await modelWith([policy('agents-off', { effect: 'deny', permissions: ['*'], actorTypes: ['agent'] })]);
      expect((await vote(m, { actor: agent })).denyWhen).to.equal(TRUE);
      expect((await vote(m)).denyWhen).to.equal(FALSE);
    });

    it('applies a scoped policy on the path, or under the scope at type level', async () => {
      const m = await modelWith([policy('o1', { scope: O1 })]);
      expect((await vote(m, { resource: F1 })).permitWhen).to.equal(TRUE);
      expect((await vote(m, { resource: F2 })).permitWhen).to.equal(FALSE);
      expect((await vote(m, { resource: { type: 'file' } })).permitWhen).to.deep.equal({ op: 'under', scopes: [O1] });
    });

    it('compiles conditions with the domain compiler and ANDs them with the scope', async () => {
      const m = await modelWith([policy('own', { scope: O1, when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } })]);
      expect((await vote(m, { resource: { type: 'file' } })).permitWhen).to.deep.equal({
        op: 'and',
        args: [
          { op: 'under', scopes: [O1] },
          { op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' },
        ],
      });
      expect((await vote(m, { resource: F1 })).permitWhen).to.deep.equal({ op: 'cmp', field: 'owner', cmp: 'eq', value: 'alice' });
    });

    it('a deny whose condition needs the subject, with none given, denies needs_subject (B19)', async () => {
      const m = await modelWith([policy('frozen', { effect: 'deny', when: { attr: 'scope.org.policies.frozen', eq: true } })]);
      const v = await vote(m, { resource: { type: 'file' } });
      expect(v.denyWhen).to.equal(TRUE);
      expect(v.denies?.[0].reason).to.deep.equal({ code: 'needs_subject', policy: 'frozen', sortKey: 'frozen' });
    });

    it('a permit needing the row it was not given permits nothing; one reading scope.* at type level is indeterminate (B39)', async () => {
      const glob = await modelWith([policy('named', { when: { fn: 'glob', args: { value: { ref: 'resource.name' }, pattern: 'a/*' } } })]);
      expect((await vote(glob, { resource: { type: 'file' } })).permitWhen).to.equal(FALSE);
      const scoped = await modelWith([policy('open-orgs', { when: { attr: 'scope.org.policies.open', eq: true } })]);
      let error: unknown;
      await vote(scoped, { resource: { type: 'file' } }).catch((e) => (error = e));
      expect((error as Error).message).to.match(/abac policy "open-orgs": its condition reads scope attributes/);
      expect((await vote(scoped, { resource: F1 })).permitWhen).to.equal(TRUE);
      error = undefined;
      await vote(scoped, { resource: F2 }).catch((e) => (error = e));
      expect((error as Error).message).to.match(/has no such attribute/);
    });

    it('keeps UNKNOWN from a condition, and marks env reads uncacheable', async () => {
      const m = await modelWith([policy('pool', { when: { attr: 'principal.attributes.pool', eq: 'gold' } }), policy('office', { effect: 'deny', when: { not: { fn: 'time.between', args: { from: '08:00', to: '18:00' } } } })]);
      const v = await vote(m);
      expect(v.permitWhen).to.equal(CONDITION_UNKNOWN);
      expect(v.denyWhen).to.equal(FALSE);
      expect(v.cacheable).to.equal(false);
    });

    it('gives field sets: permits united (no fields = every field), deny policies hide', async () => {
      const m = await modelWith([policy('read', { fields: { read: ['name', 'email'] } }), policy('locked', { effect: 'deny', when: { attr: 'resource.status', eq: 'locked' }, fields: { hide: ['email'] } })]);
      expect((await vote(m, { resource: { type: 'file' } })).fields).to.deep.equal({ read: ['email', 'name'], write: [], hide: ['email'] });
      const all = await modelWith([policy('read', { fields: { read: ['name'] } }), policy('any')]);
      expect((await vote(all)).fields).to.deep.equal({ read: ['*'], write: ['*'] });
    });

    it('drops expired policies and caps validUntil at the earliest live expiry (B14)', async () => {
      const m = await modelWith([policy('old', { expiresAt: new Date(NOW.getTime() - 1) }), policy('soon', { effect: 'deny', permissions: ['file:write'], expiresAt: new Date(NOW.getTime() + 60_000) }), policy('later', { expiresAt: new Date(NOW.getTime() + 3_600_000) })]);
      const v = await vote(m);
      expect(v.permitWhen).to.equal(TRUE);
      expect(v.validUntil?.toISOString()).to.equal(new Date(NOW.getTime() + 3_600_000).toISOString());
      expect((await vote(m, { permission: 'file:write' })).validUntil?.getTime()).to.equal(NOW.getTime() + 60_000);
    });

    it('matches principal types against companions', async () => {
      const bot = servicePrincipal('bot', { companions: [alice] });
      const m = await modelWith([policy('users', { principalTypes: ['user'] })]);
      expect((await vote(m, { principal: bot })).permitWhen).to.equal(TRUE);
      expect((await vote(m, { principal: svc })).permitWhen).to.equal(FALSE);
    });
  });

  describe('changes', () => {
    it('reloads after an invalidation of policy tags and changes its version', async () => {
      const store = new MemoryPolicyStore([policy('p1')]);
      const m = await modelWith([], { stores: [store] });
      const v1 = m.version();
      store.put(policy('p2', { effect: 'deny', reason: 'gone' }));
      expect((await vote(m)).denyWhen).to.equal(FALSE);
      m.invalidate(['user:alice']);
      expect((await vote(m)).denyWhen).to.equal(FALSE);
      m.invalidate(['policy:p2']);
      expect((await vote(m)).denyWhen).to.equal(TRUE);
      expect(m.version()).to.not.equal(v1);
    });

    it('a failed reload leaves the model to retry on the next request', async () => {
      const store = new MemoryPolicyStore([policy('p1')]);
      const m = await modelWith([], { stores: [store] });
      let fail = true;
      const load = store.load.bind(store);
      store.load = async () => {
        if (fail) throw new Error('db down');
        return load();
      };
      m.invalidate(['policy']);
      let error: unknown;
      await vote(m).catch((e) => (error = e));
      expect((error as Error).message).to.equal('db down');
      fail = false;
      expect((await vote(m)).permitWhen).to.equal(TRUE);
    });
  });

  describe('boot refs', () => {
    it('lists permission refs with their resource types and scope refs from conditions and scopes', async () => {
      const m = await modelWith([policy('p1', { resourceTypes: ['file'], scope: O1, when: { attr: 'scope.project.open', eq: true } }), policy('p2', { permissions: ['file:*'] })]);
      expect(m.contribution()).to.deep.equal({
        permissionRefs: [{ permission: 'file:read', type: 'file', source: 'abac policy "p1"' }],
        scopeRefs: [
          { type: 'project', source: 'abac policy "p1"' },
          { type: 'org', source: 'abac policy "p1"' },
        ],
      });
    });
  });

  describe('through the engine', () => {
    const engine = async (policies: readonly Policy[], algorithm = 'deny-overrides') => {
      const reg = registry();
      const m = new AbacModel({ stores: [new ConfigPolicyStore(policies)] });
      await m.init(fakeModelInitContext({ permissions: reg }));
      return new Authorizer({ domain: 'root', models: [m], registry: reg, combine: { default: { algorithm } }, scopeResolvers: [resolver()], conditions: new DefaultConditionCompiler(), clock: () => NOW });
    };
    const check = (a: Authorizer, principal: Principal, resource: ResourceRef | undefined, extra: Partial<DecisionRequest> = {}) => a.check({ principal, permission: 'file:read', ...(resource ? { resource } : {}), ...extra });

    it('reports the deny with the lowest priority, in any policy order (B36)', async () => {
      const policies = [policy('agents', { effect: 'deny', reason: 'agents_disabled', priority: 100 }), policy('blocked', { effect: 'deny', reason: 'blocked' })];
      for (const list of [policies, [...policies].reverse()]) {
        const d = await check(await engine(list), alice, F1);
        expect(d.allowed).to.equal(false);
        expect(d.reason).to.deep.include({ code: 'agents_disabled', model: 'abac' });
      }
    });

    it('evaluates a conditional permit against the subject', async () => {
      const a = await engine([policy('open', { when: { attr: 'resource.status', eq: 'open' } })]);
      expect((await check(a, alice, F1, { subject: { status: 'open' } })).allowed).to.equal(true);
      expect((await check(a, alice, F1, { subject: { status: 'closed' } })).allowed).to.equal(false);
      expect((await check(a, alice, undefined)).residual).to.deep.equal({ op: 'cmp', field: 'status', cmp: 'eq', value: 'open' });
    });

    it('denies needs_subject for a deny it cannot decide on a list', async () => {
      const a = await engine([policy('all'), policy('frozen', { effect: 'deny', when: { attr: 'scope.org.policies.frozen', eq: true } })]);
      const d = await check(a, alice, undefined);
      expect(d.allowed).to.equal(false);
      expect(d.reason?.code).to.equal('needs_subject');
    });

    it('applies an unscoped policy at GLOBAL, where covers checks', async () => {
      const a = await engine([policy('all'), policy('o1', { permissions: ['file:write'], scope: O1 })]);
      expect((await check(a, alice, GLOBAL)).allowed).to.equal(true);
      expect((await check(a, alice, GLOBAL, { permission: 'file:write' })).allowed).to.equal(false);
    });
  });
});
