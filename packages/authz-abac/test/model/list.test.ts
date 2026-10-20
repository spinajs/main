import * as chai from 'chai';
import 'mocha';
import { DefaultConditionCompiler, PermissionRegistryImpl } from '@spinajs/authz';
import type { EvaluationContext, ListPlanRequest, Policy, Principal } from '@spinajs/authz';
import { agentPrincipal, fakeEvaluationContext, fakeModelInitContext, userPrincipal } from '@spinajs/authz-testing';

import { AbacModel, MemoryPolicyStore } from '../../src/index.js';

const expect = chai.expect;

const NOW = new Date('2026-10-14T12:00:00.000Z');
const alice = userPrincipal('alice', { attributes: { dept: 'ops' } });
const bob = userPrincipal('bob', { attributes: { dept: 'sales' } });

const registry = (): PermissionRegistryImpl => {
  const r = new PermissionRegistryImpl();
  r.register(
    [
      { name: 'doc:read', types: ['doc'], list: true },
      { name: 'doc:write', types: ['doc'] },
      { name: 'doc:delete', types: ['doc'], list: true },
    ],
    'test',
  );
  r.freeze();
  return r;
};

const policy = (id: string, extra: Partial<Policy> = {}): Policy => ({ id, effect: 'permit', permissions: ['doc:read'], source: 'test', ...extra });

async function modelWith(policies: readonly Policy[]): Promise<{ model: AbacModel; registry: PermissionRegistryImpl }> {
  const reg = registry();
  const model = new AbacModel({ stores: [new MemoryPolicyStore(policies)] });
  await model.init(fakeModelInitContext({ permissions: reg }));
  return { model, registry: reg };
}

const support = async (policies: readonly Policy[], permission = 'doc:read', type = 'doc') => {
  const { model, registry: reg } = await modelWith(policies);
  return model.listSupport(reg.require(permission), type);
};

describe('authz-abac: list support', () => {
  it('is true for policies that read the principal, the actor and env only', async () => {
    expect(await support([policy('p1'), policy('p2', { when: { attr: 'principal.attributes.dept', eq: 'ops' } }), policy('d1', { effect: 'deny', when: { attr: 'env.ip', eq: '10.0.0.1' } }), policy('a1', { actorTypes: ['agent'], when: { attr: 'actor.type', eq: 'agent' } }), policy('g1', { when: { attr: 'scope.$global.flags.open', eq: true } }), policy('s1', { scope: { type: '$global' } })])).to.equal(true);
  });

  it('refuses a permit or a deny that reads resource.*', async () => {
    expect(await support([policy('own', { when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } })])).to.deep.equal({ reason: 'abac policy "own" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
    expect(await support([policy('closed', { effect: 'deny', when: { attr: 'resource.status', eq: 'closed' } })])).to.deep.equal({ reason: 'abac policy "closed" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
  });

  it('refuses a function whose args read resource.*', async () => {
    const out = await support([policy('named', { when: { fn: 'glob', args: { value: { ref: 'resource.name' }, pattern: 'a/*' } } })]);
    expect(out).to.deep.equal({ reason: 'abac policy "named" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable' });
  });

  it('refuses scope attributes of a node and a scoped policy', async () => {
    expect(await support([policy('frozen', { effect: 'deny', when: { attr: 'scope.org.policies.frozen', eq: true } })])).to.deep.equal({ reason: 'abac policy "frozen" (source: test) reads scope.org.* in its condition, so doc:read on "doc" is not list-filterable' });
    expect(await support([policy('org', { scope: { type: 'org', id: 'o1' } })])).to.deep.equal({ reason: 'abac policy "org" (source: test) applies under org:o1 only, so doc:read on "doc" is not list-filterable' });
  });

  it('ignores policies that cannot match the permission or the type', async () => {
    expect(await support([policy('w', { permissions: ['doc:write'], when: { attr: 'resource.x', eq: 1 } }), policy('t', { resourceTypes: ['folder'], when: { attr: 'resource.x', eq: 1 } })])).to.equal(true);
  });

  it('listProblem names the list permission a new policy would break, or nothing', async () => {
    const { model } = await modelWith([]);
    expect(model.listProblem({ id: 'n', effect: 'deny', permissions: ['doc:*'], when: { attr: 'resource.status', eq: 'x' } })).to.equal('abac policy "n" (source: db) reads resource.* in its condition, so doc:delete on "doc" is not list-filterable');
    expect(model.listProblem({ id: 'w', effect: 'permit', permissions: ['doc:write'], when: { attr: 'resource.status', eq: 'x' } })).to.equal(undefined);
    expect(model.listProblem({ id: 'ok', effect: 'permit', permissions: ['doc:read'], when: { attr: 'principal.attributes.dept', eq: 'ops' } })).to.equal(undefined);
  });
});

describe('authz-abac: list plan', () => {
  const ctx = (): EvaluationContext => fakeEvaluationContext({ now: NOW, permissions: registry(), conditions: new DefaultConditionCompiler() });

  async function plan(policies: readonly Policy[], over: Partial<ListPlanRequest> & { principal?: Principal } = {}) {
    const { model, registry: reg } = await modelWith(policies);
    return model.listPlan({ principal: alice, permission: reg.require('doc:read'), type: 'doc', env: { now: NOW }, ...over }, ctx());
  }

  it('abstains when no policy matches', async () => {
    expect(await plan([])).to.deep.equal({ kind: 'abstain' });
    expect(await plan([policy('p', { when: { attr: 'principal.attributes.dept', eq: 'sales' } })])).to.deep.equal({ kind: 'abstain' });
  });

  it('lists every row when a permit holds for the principal', async () => {
    expect(await plan([policy('p', { when: { attr: 'principal.attributes.dept', eq: 'ops' } })])).to.deep.equal({ kind: 'all' });
    expect(await plan([policy('p', { when: { attr: 'principal.attributes.dept', eq: 'ops' } })], { principal: bob })).to.deep.equal({ kind: 'abstain' });
  });

  it('a holding deny beats a permit, with the policy reason and priority', async () => {
    const out = await plan([policy('p'), policy('mfa', { effect: 'deny', when: { attr: 'env.mfa', eq: false }, reason: 'mfa_required', priority: 50 })], { env: { now: NOW, mfa: false } });
    expect(out).to.deep.equal({ kind: 'deny-all', reason: { code: 'mfa_required', policy: 'mfa', priority: 50, sortKey: 'mfa' } });
    expect(await plan([policy('p'), policy('mfa', { effect: 'deny', when: { attr: 'env.mfa', eq: false }, reason: 'mfa_required' })], { env: { now: NOW, mfa: true } })).to.deep.equal({ kind: 'all' });
  });

  it('of several holding denies the lowest priority wins', async () => {
    const out = await plan([policy('a', { effect: 'deny', reason: 'a', priority: 300 }), policy('b', { effect: 'deny', reason: 'b', priority: 100 })]);
    expect(out).to.deep.equal({ kind: 'deny-all', reason: { code: 'b', policy: 'b', priority: 100, sortKey: 'b' } });
  });

  it('reads the actor of the request', async () => {
    const agent = agentPrincipal('ag1', alice);
    const policies = [policy('p'), policy('no-agents', { effect: 'deny', actorTypes: ['agent'], reason: 'agents_disabled' })];
    expect((await plan(policies, { actor: agent })).kind).to.equal('deny-all');
    expect(await plan(policies)).to.deep.equal({ kind: 'all' });
  });

  it('bounds the plan by the earliest expiry of the policies that held', async () => {
    const soon = new Date(NOW.getTime() + 60_000);
    const later = new Date(NOW.getTime() + 120_000);
    expect(await plan([policy('a', { expiresAt: later }), policy('b', { expiresAt: soon })])).to.deep.equal({ kind: 'all', validUntil: soon });
    expect(await plan([policy('gone', { expiresAt: new Date(NOW.getTime() - 1) })])).to.deep.equal({ kind: 'abstain' });
  });

  it('fails closed on a policy that needs the row', async () => {
    let caught: unknown;
    try {
      await plan([policy('own', { when: { attr: 'resource.owner', eq: { ref: 'principal.id' } } })]);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).to.equal('abac policy "own" (source: test) reads resource.* in its condition, so doc:read on "doc" is not list-filterable');
  });
});
